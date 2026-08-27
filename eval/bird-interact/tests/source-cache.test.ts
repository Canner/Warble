import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import ts from "typescript";

import {
  BIRD_COMMIT,
  BIRD_REPOSITORY,
  HF_COMMIT,
  HF_REPOSITORY,
  MAIN_PUBLIC_SHA256,
  ensureBirdCheckout,
  ensurePublicSnapshot,
  verifyBirdCheckout,
  verifyPublicSnapshotOffline,
  type CommandRunner,
  type FetchLike,
} from "../src/source-cache.js";

const execFileAsync = promisify(execFile);
const TRACKED_PUBLIC_SNAPSHOT = JSON.parse(
  readFileSync(new URL("../public-snapshot.json", import.meta.url), "utf8"),
) as {
  repository: string;
  commit: string;
  files: Array<{ type: "file"; path: string; oid: string; size: number }>;
};
const REQUIRED_BIRD_FILES = [
  "BIRD-Interact-ADK/requirements.txt",
  "BIRD-Interact-ADK/shared/config.py",
  "BIRD-Interact-ADK/db_environment/server.py",
  "BIRD-Interact-ADK/user_simulator/server.py",
  "BIRD-Interact-ADK/orchestrator/runner.py",
] as const;

async function git(cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function makeTempRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "warble-source-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

interface FilesystemEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "symlink" | "other";
  readonly mode: number;
  readonly content?: string;
}

async function snapshotFilesystem(root: string, relative = ""): Promise<FilesystemEntry[]> {
  const entries: FilesystemEntry[] = [];
  const absolute = relative === "" ? root : join(root, relative);
  for (const name of (await readdir(absolute)).sort()) {
    const child = relative === "" ? name : `${relative}/${name}`;
    const details = await lstat(join(root, child));
    if (details.isDirectory()) {
      entries.push({ path: child, type: "directory", mode: details.mode & 0o777 });
      entries.push(...await snapshotFilesystem(root, child));
    } else if (details.isFile()) {
      entries.push({
        path: child,
        type: "file",
        mode: details.mode & 0o777,
        content: createHash("sha256").update(await readFile(join(root, child))).digest("hex"),
      });
    } else if (details.isSymbolicLink()) {
      entries.push({ path: child, type: "symlink", mode: details.mode & 0o777, content: await readlink(join(root, child)) });
    } else {
      entries.push({ path: child, type: "other", mode: details.mode & 0o777 });
    }
  }
  return entries;
}

async function makeSeed(root: string, origin = BIRD_REPOSITORY, files: readonly string[] = REQUIRED_BIRD_FILES): Promise<string> {
  const seed = join(root, "seed");
  await mkdir(seed);
  await git(seed, ["init", "--quiet"]);
  await git(seed, ["config", "user.name", "Warble Test"]);
  await git(seed, ["config", "user.email", "warble@example.invalid"]);
  for (const path of files) {
    const absolute = join(seed, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `official fixture for ${path}\n`);
  }
  await writeFile(join(seed, ".gitignore"), ".env\n_local_provider.py\n__pycache__/\n*.pyc\n*.pyo\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "--quiet", "-m", "fixture"]);
  await git(seed, ["remote", "add", "origin", origin]);
  await git(seed, ["checkout", "--quiet", "--detach"]);
  return seed;
}

function gitOperation(args: readonly string[]): readonly string[] {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args.slice(index);
}

function pinnedRunner(
  onCommand?: (args: readonly string[], cwd: string | undefined, options: Parameters<CommandRunner>[2]) => void,
): CommandRunner {
  return async (command, args, options) => {
    onCommand?.(args, options.cwd, options);
    const operation = gitOperation(args);
    if (command === "git" && operation[0] === "rev-parse" && operation[1] === "HEAD") {
      return { stdout: `${BIRD_COMMIT}\n`, stderr: "" };
    }
    if (command === "git" && operation[0] === "checkout" && operation.includes(BIRD_COMMIT)) {
      const translated = args.map((arg) => arg === BIRD_COMMIT ? "HEAD" : arg);
      return realRunner(command, translated, options);
    }
    assert.equal(command, "git");
    const result = await execFileAsync(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      encoding: "utf8",
      ...((options as { env?: NodeJS.ProcessEnv }).env === undefined
        ? {}
        : { env: (options as { env: NodeJS.ProcessEnv }).env }),
      timeout: options.timeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

function pinnedRunnerWithHead(
  head: string,
  onCommand?: (args: readonly string[], cwd: string | undefined, options: Parameters<CommandRunner>[2]) => void,
): CommandRunner {
  const base = pinnedRunner(onCommand);
  return async (command, args, options) => {
    const operation = gitOperation(args);
    if (command === "git" && operation[0] === "rev-parse" && operation[1] === "HEAD") {
      onCommand?.(args, options.cwd, options);
      return { stdout: `${head}\n`, stderr: "" };
    }
    return base(command, args, options);
  };
}

const realRunner: CommandRunner = async (command, args, options) => {
  assert.equal(command, "git");
  const result = await execFileAsync(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    encoding: "utf8",
    ...((options as { env?: NodeJS.ProcessEnv }).env === undefined
      ? {}
      : { env: (options as { env: NodeJS.ProcessEnv }).env }),
    timeout: options.timeoutMs,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

test("pins the official BIRD and Hugging Face sources", () => {
  assert.equal(BIRD_REPOSITORY, "https://github.com/bird-bench/BIRD-Interact.git");
  assert.equal(BIRD_COMMIT, "451fe2c3518ee1cf908d8139e2913483bd519381");
  assert.equal(HF_REPOSITORY, "https://huggingface.co/datasets/birdsql/bird-interact-lite");
  assert.equal(HF_COMMIT, "f7881a9c2b9630cc4fc13b0c39279740b0a2fd87");
  assert.equal(MAIN_PUBLIC_SHA256, "d155fa0855bc1885f77df2fcc357d3056e10426cd6093c0042aa99d79067af08");
});

test("the public offline verifier performs no network fallback", async (t) => {
  const root = await makeTempRoot(t);
  await assert.rejects(
    verifyPublicSnapshotOffline(join(root, "missing")),
    /does not exist/i,
  );
});

test("loads a sorted 57-file public trust root with 18 complete metadata triplets", () => {
  assert.equal(TRACKED_PUBLIC_SNAPSHOT.files.length, 57);
  assert.deepEqual(
    TRACKED_PUBLIC_SNAPSHOT.files.map((file) => file.path),
    [...TRACKED_PUBLIC_SNAPSHOT.files.map((file) => file.path)].sort(),
  );
  assert.equal(new Set(TRACKED_PUBLIC_SNAPSHOT.files.map((file) => file.path)).size, 57);
  assert.ok(TRACKED_PUBLIC_SNAPSHOT.files.some((file) =>
    file.path === "bird_interact_data.jsonl" &&
    file.oid === "e3ef8f5fac383655d7833614e2f6a889ab242e38" &&
    file.size === 719_177
  ));

  const paths = new Set(TRACKED_PUBLIC_SNAPSHOT.files.map((file) => file.path));
  const databases = TRACKED_PUBLIC_SNAPSHOT.files
    .filter((file) => file.path.endsWith("_schema.txt"))
    .map((file) => file.path.split("/")[0]!);
  assert.equal(databases.length, 18);
  for (const database of databases) {
    assert.equal(paths.has(`${database}/${database}_schema.txt`), true);
    assert.equal(paths.has(`${database}/${database}_column_meaning_base.json`), true);
    assert.equal(paths.has(`${database}/${database}_kb.jsonl`), true);
  }
});

test("locks every tracked path/type/OID/size tuple to an independent canonical trust hash", () => {
  const canonical = JSON.stringify({
    repository: TRACKED_PUBLIC_SNAPSHOT.repository,
    commit: TRACKED_PUBLIC_SNAPSHOT.commit,
    files: TRACKED_PUBLIC_SNAPSHOT.files.map(({ type, path, oid, size }) => ({ type, path, oid, size })),
  });
  assert.equal(
    createHash("sha256").update(canonical).digest("hex"),
    "f4af972b3d5e4b8220aeb99d7041102863570bfa8027a830dfc8d0277379679e",
  );
});

test("imports a verified seed as a fresh managed clone and reuses it idempotently", async (t) => {
  const root = await makeTempRoot(t);
  const seed = await makeSeed(root);
  const cacheDir = join(root, "cache", "BIRD-Interact");
  let cloneCount = 0;
  const runner = pinnedRunner((args) => {
    if (gitOperation(args)[0] === "clone") cloneCount += 1;
  });

  const imported = await ensureBirdCheckout({ cacheDir, seedDir: seed, runner });
  assert.equal(imported.path, cacheDir);
  assert.equal(imported.commit, BIRD_COMMIT);
  assert.equal(cloneCount, 1);
  const seedFile = await stat(join(seed, REQUIRED_BIRD_FILES[0]));
  const cacheFile = await stat(join(cacheDir, REQUIRED_BIRD_FILES[0]));
  assert.equal(cacheFile.isFile(), true);
  assert.notDeepEqual([cacheFile.dev, cacheFile.ino], [seedFile.dev, seedFile.ino]);
  assert.equal(
    await readFile(join(cacheDir, ".git", "info", "exclude"), "utf8"),
    "/BIRD-Interact-ADK/.venv/\n/BIRD-Interact-ADK/bird-interact-lite\n",
  );

  const reused = await ensureBirdCheckout({ cacheDir, seedDir: join(root, "does-not-exist"), runner });
  assert.deepEqual(reused, imported);
  assert.equal(cloneCount, 1);
  assert.deepEqual(await verifyBirdCheckout(cacheDir, { runner }), imported);
});

test("network acquisition uses only bounded execFile-style Git argument arrays", async (t) => {
  const root = await makeTempRoot(t);
  const localOfficialStandIn = await makeSeed(root);
  const cacheDir = join(root, "cache", "BIRD-Interact");
  const commands: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
  const pinned = pinnedRunner();
  const runner: CommandRunner = async (command, args, options) => {
    commands.push({ command, args: [...args], timeoutMs: options.timeoutMs });
    const operation = gitOperation(args);
    if (operation[0] === "clone" && operation[2] === BIRD_REPOSITORY) {
      return realRunner(command, [
        ...args.slice(0, args.length - operation.length),
        operation[0]!,
        operation[1]!,
        localOfficialStandIn,
        operation[3]!,
      ], options);
    }
    return pinned(command, args, options);
  };

  await ensureBirdCheckout({ cacheDir, runner });
  assert.ok(commands.some(({ args }) =>
    JSON.stringify(gitOperation(args).slice(0, 3)) === JSON.stringify(["clone", "--no-hardlinks", BIRD_REPOSITORY])
  ));
  assert.ok(commands.some(({ args }) =>
    JSON.stringify(gitOperation(args)) === JSON.stringify(["checkout", "--detach", BIRD_COMMIT])
  ));
  assert.equal(commands.every(({ command }) => command === "git"), true);
  assert.equal(commands.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 120_000), true);
});

test("every Git command disables repository execution surfaces and inherited configuration", async (t) => {
  const root = await makeTempRoot(t);
  const seed = await makeSeed(root);
  const sentinel = join(root, "GIT_COMMAND_EXECUTED");
  const fsmonitor = join(root, "fsmonitor.sh");
  const hooks = join(root, "hooks");
  await writeFile(fsmonitor, `#!/bin/sh\nprintf executed > '${sentinel}'\nprintf '0\\n'\n`);
  await chmod(fsmonitor, 0o755);
  await mkdir(hooks);
  for (const hook of ["post-checkout", "post-index-change"]) {
    const hookPath = join(hooks, hook);
    await writeFile(hookPath, `#!/bin/sh\nprintf executed > '${sentinel}'\n`);
    await chmod(hookPath, 0o755);
  }
  await git(seed, ["config", "core.fsmonitor", fsmonitor]);
  await git(seed, ["config", "core.hooksPath", hooks]);

  const observations: Array<{ args: readonly string[]; env: Readonly<NodeJS.ProcessEnv> | undefined }> = [];
  const runner = pinnedRunner((args, _cwd, options) => {
    observations.push({ args: [...args], env: (options as { env?: Readonly<NodeJS.ProcessEnv> }).env });
  });
  await ensureBirdCheckout({ cacheDir: join(root, "cache", "BIRD-Interact"), seedDir: seed, runner });

  await assert.rejects(lstat(sentinel), /ENOENT/);
  assert.ok(observations.length > 0);
  for (const { args, env } of observations) {
    assert.deepEqual(args.slice(0, 6), [
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.attributesFile=/dev/null",
    ]);
    assert.equal(env?.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env?.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env?.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env?.GIT_OPTIONAL_LOCKS, "0");
  }
});

test("rejects attached HEAD independently for seeds and reused caches", async (t) => {
  await t.test("seed", async (subtest) => {
    const root = await makeTempRoot(subtest);
    const seed = await makeSeed(root);
    await git(seed, ["switch", "--quiet", "-c", "attached"]);
    let cloneCount = 0;
    const runner = pinnedRunner((args) => {
      if (gitOperation(args)[0] === "clone") cloneCount += 1;
    });
    await assert.rejects(
      ensureBirdCheckout({ cacheDir: join(root, "cache"), seedDir: seed, runner }),
      /detached/i,
    );
    assert.equal(cloneCount, 0);
  });

  await t.test("reused cache", async (subtest) => {
    const root = await makeTempRoot(subtest);
    const seed = await makeSeed(root);
    const cacheDir = join(root, "cache");
    const runner = pinnedRunner();
    await ensureBirdCheckout({ cacheDir, seedDir: seed, runner });
    await git(cacheDir, ["switch", "--quiet", "-c", "attached"]);
    const before = await snapshotFilesystem(cacheDir);
    await assert.rejects(ensureBirdCheckout({ cacheDir, runner }), /detached/i);
    assert.deepEqual(await snapshotFilesystem(cacheDir), before);
  });
});

test("rejects assume-unchanged and skip-worktree tampering for seeds and reused caches", async (t) => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"] as const) {
    for (const kind of ["seed", "cache"] as const) {
      await t.test(`${kind} ${flag}`, async (subtest) => {
        const root = await makeTempRoot(subtest);
        const seed = await makeSeed(root);
        const cacheDir = join(root, "cache");
        const runner = pinnedRunner();
        if (kind === "cache") await ensureBirdCheckout({ cacheDir, seedDir: seed, runner });
        const targetRoot = kind === "seed" ? seed : cacheDir;
        const relative = REQUIRED_BIRD_FILES[4];
        await git(targetRoot, ["update-index", flag, relative]);
        await writeFile(join(targetRoot, relative), "DO_NOT_LEAK\n");
        const before = await snapshotFilesystem(targetRoot);
        let cloneCount = 0;
        const checkingRunner = pinnedRunner((args) => {
          if (gitOperation(args)[0] === "clone") cloneCount += 1;
        });
        const action = kind === "seed"
          ? ensureBirdCheckout({ cacheDir, seedDir: seed, runner: checkingRunner })
          : ensureBirdCheckout({ cacheDir, runner: checkingRunner });
        await assert.rejects(action, /index|flag|worktree|tracked/i);
        if (kind === "seed") assert.equal(cloneCount, 0);
        assert.deepEqual(await snapshotFilesystem(targetRoot), before);
      });
    }
  }
});

test("accepts only legitimate HTTPS and SSH spellings of the exact BIRD origin", async (t) => {
  const root = await makeTempRoot(t);
  const seed = await makeSeed(root);
  const cacheDir = join(root, "cache", "BIRD-Interact");
  const runner = pinnedRunner();
  await ensureBirdCheckout({ cacheDir, seedDir: seed, runner });

  for (const origin of [
    "https://github.com/bird-bench/BIRD-Interact.git",
    "https://github.com/bird-bench/BIRD-Interact",
    "git@github.com:bird-bench/BIRD-Interact.git",
    "git@github.com:bird-bench/BIRD-Interact",
    "ssh://git@github.com/bird-bench/BIRD-Interact.git",
    "ssh://git@github.com/bird-bench/BIRD-Interact",
  ]) {
    await git(cacheDir, ["remote", "set-url", "origin", origin]);
    assert.equal((await verifyBirdCheckout(cacheDir, { runner })).commit, BIRD_COMMIT);
  }

  for (const origin of [
    "http://github.com/bird-bench/BIRD-Interact.git",
    "https://github.com.evil.invalid/bird-bench/BIRD-Interact.git",
    "https://github.com@evil.invalid/bird-bench/BIRD-Interact.git",
    "https://github.com/bird-bench/BIRD-Interact-extra.git",
    "git@evil.invalid:bird-bench/BIRD-Interact.git",
  ]) {
    await git(cacheDir, ["remote", "set-url", "origin", origin]);
    await assert.rejects(verifyBirdCheckout(cacheDir, { runner }), /origin/i);
  }
});

test("rejects a wrong seed origin without creating a cache", async (t) => {
  const root = await makeTempRoot(t);
  const seed = await makeSeed(root, "https://example.invalid/not-bird.git");
  const cacheDir = join(root, "cache", "BIRD-Interact");
  await assert.rejects(ensureBirdCheckout({ cacheDir, seedDir: seed, runner: pinnedRunner() }), /origin/i);
  await assert.rejects(stat(cacheDir), /ENOENT/);
});

test("rejects a reused cache whose origin changed and leaves it untouched", async (t) => {
  const root = await makeTempRoot(t);
  const seed = await makeSeed(root);
  const cacheDir = join(root, "cache", "BIRD-Interact");
  const runner = pinnedRunner();
  await ensureBirdCheckout({ cacheDir, seedDir: seed, runner });
  const required = join(cacheDir, REQUIRED_BIRD_FILES[0]);
  const before = await readFile(required);
  await git(cacheDir, ["remote", "set-url", "origin", "https://example.invalid/not-bird.git"]);

  await assert.rejects(ensureBirdCheckout({ cacheDir, runner }), /origin/i);
  assert.deepEqual(await readFile(required), before);
});

test("rejects a seed at any commit other than the exact BIRD pin", async (t) => {
  const root = await makeTempRoot(t);
  const seed = await makeSeed(root);
  await assert.rejects(
    ensureBirdCheckout({ cacheDir: join(root, "cache", "BIRD-Interact"), seedDir: seed, runner: realRunner }),
    /pinned commit/i,
  );
});

test("rejects a clean seed missing any required official file", async (t) => {
  const root = await makeTempRoot(t);
  const seed = await makeSeed(root, BIRD_REPOSITORY, REQUIRED_BIRD_FILES.slice(0, -1));
  await assert.rejects(
    ensureBirdCheckout({ cacheDir: join(root, "cache", "BIRD-Interact"), seedDir: seed, runner: pinnedRunner() }),
    /missing required file/i,
  );
});

test("allows only a real managed venv directory and the exact public-data symlink on reuse", async (t) => {
  const root = await makeTempRoot(t);
  const seed = await makeSeed(root);
  const cacheDir = join(root, "cache", "BIRD-Interact");
  const runner = pinnedRunner();
  const expected = await ensureBirdCheckout({ cacheDir, seedDir: seed, runner });
  await mkdir(join(cacheDir, "BIRD-Interact-ADK", ".venv", "lib", "__pycache__"), { recursive: true });
  await writeFile(join(cacheDir, "BIRD-Interact-ADK", ".venv", "lib", "__pycache__", "allowed.pyc"), "local\n");
  const externalPublicData = join(root, "public-data");
  await mkdir(externalPublicData);
  await symlink(externalPublicData, join(cacheDir, "BIRD-Interact-ADK", "bird-interact-lite"));
  assert.deepEqual(await ensureBirdCheckout({ cacheDir, runner }), expected);

  await writeFile(join(cacheDir, ".git", "info", "exclude"), `${await readFile(join(cacheDir, ".git", "info", "exclude"), "utf8")}*.log\n`);
  await assert.rejects(verifyBirdCheckout(cacheDir, { runner }), /exclusions/i);
});

test("external seeds reject every runtime entry while managed caches enforce exact entry types", async (t) => {
  const seedCases: ReadonlyArray<readonly [string, (seed: string, root: string) => Promise<void>]> = [
    ["venv directory", async (seed) => {
      await mkdir(join(seed, "BIRD-Interact-ADK", ".venv", "bin"), { recursive: true });
      await writeFile(join(seed, "BIRD-Interact-ADK", ".venv", "bin", "python"), "runtime\n");
      await writeFile(join(seed, ".git", "info", "exclude"), "/BIRD-Interact-ADK/.venv/\n");
    }],
    ["public-data symlink", async (seed, root) => {
      const external = join(root, "external-public");
      await mkdir(external);
      await symlink(external, join(seed, "BIRD-Interact-ADK", "bird-interact-lite"));
      await writeFile(join(seed, ".git", "info", "exclude"), "/BIRD-Interact-ADK/bird-interact-lite\n");
    }],
    ["public-data directory", async (seed) => {
      await mkdir(join(seed, "BIRD-Interact-ADK", "bird-interact-lite"));
      await writeFile(join(seed, "BIRD-Interact-ADK", "bird-interact-lite", "data"), "runtime\n");
      await writeFile(join(seed, ".git", "info", "exclude"), "/BIRD-Interact-ADK/bird-interact-lite/\n");
    }],
  ];
  for (const [name, mutate] of seedCases) {
    await t.test(`seed ${name}`, async (subtest) => {
      const root = await makeTempRoot(subtest);
      const seed = await makeSeed(root);
      await mutate(seed, root);
      let cloneCount = 0;
      const runner = pinnedRunner((args) => {
        if (gitOperation(args)[0] === "clone") cloneCount += 1;
      });
      await assert.rejects(
        ensureBirdCheckout({ cacheDir: join(root, "cache"), seedDir: seed, runner }),
        /runtime|untracked|ignored|entry/i,
      );
      assert.equal(cloneCount, 0);
    });
  }

  const cacheCases: ReadonlyArray<readonly [string, (cache: string, root: string) => Promise<void>]> = [
    ["public-data regular file", async (cache) => {
      await writeFile(join(cache, "BIRD-Interact-ADK", "bird-interact-lite"), "runtime\n");
    }],
    ["public-data directory", async (cache) => {
      await mkdir(join(cache, "BIRD-Interact-ADK", "bird-interact-lite"));
      await writeFile(join(cache, "BIRD-Interact-ADK", "bird-interact-lite", "data"), "runtime\n");
    }],
    ["venv regular file", async (cache) => {
      await writeFile(join(cache, "BIRD-Interact-ADK", ".venv"), "runtime\n");
    }],
    ["venv symlink", async (cache, root) => {
      const external = join(root, "external-venv");
      await mkdir(external);
      await symlink(external, join(cache, "BIRD-Interact-ADK", ".venv"));
    }],
  ];
  for (const [name, mutate] of cacheCases) {
    await t.test(`cache ${name}`, async (subtest) => {
      const root = await makeTempRoot(subtest);
      const seed = await makeSeed(root);
      const cacheDir = join(root, "cache");
      const runner = pinnedRunner();
      await ensureBirdCheckout({ cacheDir, seedDir: seed, runner });
      await mutate(cacheDir, root);
      const before = await snapshotFilesystem(cacheDir);
      await assert.rejects(ensureBirdCheckout({ cacheDir, runner }), /runtime|untracked|ignored|entry|symlink/i);
      assert.deepEqual(await snapshotFilesystem(cacheDir), before);
    });
  }
});

test("rejects a required checkout file hardlinked to an external source", async (t) => {
  const root = await makeTempRoot(t);
  const seed = await makeSeed(root);
  const cacheDir = join(root, "cache", "BIRD-Interact");
  const runner = pinnedRunner();
  await ensureBirdCheckout({ cacheDir, seedDir: seed, runner });
  const required = join(cacheDir, REQUIRED_BIRD_FILES[0]);
  const external = join(root, "external-copy");
  await writeFile(external, await readFile(required));
  await rm(required);
  await link(external, required);

  await assert.rejects(verifyBirdCheckout(cacheDir, { runner }), /hardlink/i);
});

test("independently rejects the complete seed and reused-cache Git mutation matrix", async (t) => {
  interface Mutation {
    readonly name: string;
    readonly head?: string;
    mutate(checkout: string, root: string): Promise<void>;
  }
  const mutations: Mutation[] = [
    {
      name: "wrong origin",
      async mutate(checkout) {
        await git(checkout, ["remote", "set-url", "origin", "https://example.invalid/not-bird.git"]);
      },
    },
    {
      name: "wrong HEAD",
      head: "0".repeat(40),
      async mutate() {},
    },
    {
      name: "attached HEAD",
      async mutate(checkout) {
        await git(checkout, ["switch", "--quiet", "-c", "attached-matrix"]);
      },
    },
    {
      name: "staged addition",
      async mutate(checkout) {
        await writeFile(join(checkout, "staged.txt"), "DO_NOT_LEAK\n");
        await git(checkout, ["add", "staged.txt"]);
      },
    },
    {
      name: "tracked modification",
      async mutate(checkout) {
        await writeFile(join(checkout, REQUIRED_BIRD_FILES[0]), "DO_NOT_LEAK\n");
      },
    },
    {
      name: "tracked deletion",
      async mutate(checkout) {
        await rm(join(checkout, REQUIRED_BIRD_FILES[0]));
      },
    },
    {
      name: "untracked file",
      async mutate(checkout) {
        await writeFile(join(checkout, "DO_NOT_LEAK.txt"), "DO_NOT_LEAK\n");
      },
    },
    ...REQUIRED_BIRD_FILES.map((relative): Mutation => ({
      name: `missing required ${relative}`,
      async mutate(checkout) {
        await rm(join(checkout, relative));
      },
    })),
    ...REQUIRED_BIRD_FILES.map((relative): Mutation => ({
      name: `wrong required type ${relative}`,
      async mutate(checkout) {
        await rm(join(checkout, relative));
        await mkdir(join(checkout, relative));
      },
    })),
    ...[
      "BIRD-Interact-ADK/.env",
      "BIRD-Interact-ADK/shared/_local_provider.py",
      "BIRD-Interact-ADK/shared/standalone.pyc",
      "BIRD-Interact-ADK/orchestrator/standalone.pyo",
    ].map((relative): Mutation => ({
      name: `ignored runtime ${relative}`,
      async mutate(checkout) {
        await mkdir(dirname(join(checkout, relative)), { recursive: true });
        await writeFile(join(checkout, relative), "DO_NOT_LEAK\n");
      },
    })),
    {
      name: "ignored standalone __pycache__",
      async mutate(checkout) {
        await mkdir(join(checkout, "BIRD-Interact-ADK", "shared", "__pycache__"));
      },
    },
    ...(["--assume-unchanged", "--skip-worktree"] as const).map((flag): Mutation => ({
      name: `index flag ${flag}`,
      async mutate(checkout) {
        const relative = REQUIRED_BIRD_FILES[4];
        await git(checkout, ["update-index", flag, relative]);
        await writeFile(join(checkout, relative), "DO_NOT_LEAK\n");
      },
    })),
    {
      name: "hardlinked tracked file",
      async mutate(checkout, root) {
        const relative = REQUIRED_BIRD_FILES[0];
        const external = join(root, "external-hardlink");
        await writeFile(external, await readFile(join(checkout, relative)));
        await rm(join(checkout, relative));
        await link(external, join(checkout, relative));
      },
    },
    {
      name: "executable-bit mutation",
      async mutate(checkout) {
        await chmod(join(checkout, REQUIRED_BIRD_FILES[0]), 0o755);
      },
    },
    {
      name: "symlink type mutation",
      async mutate(checkout, root) {
        const relative = REQUIRED_BIRD_FILES[0];
        const external = join(root, "external-symlink");
        await writeFile(external, await readFile(join(checkout, relative)));
        await rm(join(checkout, relative));
        await symlink(external, join(checkout, relative));
      },
    },
  ];

  for (const kind of ["seed", "cache"] as const) {
    for (const mutation of mutations) {
      await t.test(`${kind}: ${mutation.name}`, async (subtest) => {
        const root = await makeTempRoot(subtest);
        const seed = await makeSeed(root);
        const cacheDir = join(root, "cache");
        if (kind === "cache") await ensureBirdCheckout({ cacheDir, seedDir: seed, runner: pinnedRunner() });
        const checkout = kind === "seed" ? seed : cacheDir;
        await mutation.mutate(checkout, root);
        const before = await snapshotFilesystem(checkout);
        let cloneCount = 0;
        const onCommand = (args: readonly string[]) => {
          if (gitOperation(args)[0] === "clone") cloneCount += 1;
        };
        const runner = mutation.head === undefined
          ? pinnedRunner(onCommand)
          : pinnedRunnerWithHead(mutation.head, onCommand);
        const action = kind === "seed"
          ? ensureBirdCheckout({ cacheDir, seedDir: seed, runner })
          : ensureBirdCheckout({ cacheDir, runner });
        await assert.rejects(
          action,
          (error: unknown) => error instanceof Error && !error.message.includes("DO_NOT_LEAK"),
        );
        if (kind === "seed") assert.equal(cloneCount, 0);
        assert.deepEqual(await snapshotFilesystem(checkout), before);
      });
    }
  }
});

test("post-checkout re-verification failure removes only sibling staging", async (t) => {
  const root = await makeTempRoot(t);
  const seed = await makeSeed(root);
  const cacheParent = join(root, "managed");
  const cacheDir = join(cacheParent, "BIRD-Interact");
  const outside = join(root, "outside-sentinel");
  await writeFile(outside, "outside stays intact\n");
  const base = pinnedRunner();
  let sabotaged = false;
  const runner: CommandRunner = async (command, args, options) => {
    const result = await base(command, args, options);
    if (!sabotaged && gitOperation(args)[0] === "checkout" && options.cwd !== undefined) {
      sabotaged = true;
      await writeFile(join(options.cwd, REQUIRED_BIRD_FILES[4]), "DO_NOT_LEAK\n");
    }
    return result;
  };

  await assert.rejects(
    ensureBirdCheckout({ cacheDir, seedDir: seed, runner }),
    (error: unknown) => error instanceof Error && !error.message.includes("DO_NOT_LEAK"),
  );
  await assert.rejects(lstat(cacheDir), /ENOENT/);
  assert.deepEqual((await readdir(cacheParent)).filter((name) => name.includes(".tmp-")), []);
  assert.equal(await readFile(outside, "utf8"), "outside stays intact\n");
});

function officialTreeEntries(): Array<{ type: "file" | "directory"; path: string; oid: string; size: number }> {
  const directories = [...new Set(TRACKED_PUBLIC_SNAPSHOT.files
    .filter((file) => file.path.includes("/"))
    .map((file) => file.path.split("/")[0]!))]
    .map((path) => ({ type: "directory" as const, path, oid: "0".repeat(40), size: 0 }));
  return [...directories, ...TRACKED_PUBLIC_SNAPSHOT.files.map((file) => ({ ...file }))];
}

test("follows only same-origin pinned tree pagination before downloading", async (t) => {
  const root = await makeTempRoot(t);
  const entries = officialTreeEntries();
  const secondUrl = `https://huggingface.co/api/datasets/birdsql/bird-interact-lite/tree/${HF_COMMIT}?recursive=true&limit=1000&cursor=next`;
  const requested: string[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = String(input);
    requested.push(url);
    assert.equal(init?.redirect, "manual");
    if (requested.length === 1) {
      return new Response(JSON.stringify(entries.slice(0, 30)), {
        headers: { link: `<${secondUrl}>; rel="next"` },
      });
    }
    if (url === secondUrl) return new Response(JSON.stringify(entries.slice(30)));
    return new Response("wrong", { headers: { "content-length": "5" } });
  };

  await assert.rejects(
    ensurePublicSnapshot({ cacheDir: join(root, "bird-interact-lite"), fetch: fetcher }),
    /size|hash|download/i,
  );
  assert.deepEqual(requested.slice(0, 2), [
    `https://huggingface.co/api/datasets/birdsql/bird-interact-lite/tree/${HF_COMMIT}?recursive=true&limit=1000`,
    secondUrl,
  ]);
});

test("streams the main public file into sibling staging and rejects the wrong SHA-256", async (t) => {
  const root = await makeTempRoot(t);
  const cacheDir = join(root, "bird-interact-lite");
  let fileRequests = 0;
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("/api/datasets/")) {
      return new Response(JSON.stringify(officialTreeEntries()));
    }
    fileRequests += 1;
    assert.equal(
      url,
      `https://huggingface.co/datasets/birdsql/bird-interact-lite/resolve/${HF_COMMIT}/bird_interact_data.jsonl`,
    );
    const bytes = Buffer.alloc(719_177, 0x61);
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  };

  await assert.rejects(
    ensurePublicSnapshot({ cacheDir, fetch: fetcher }),
    /SHA-256/i,
  );
  assert.equal(fileRequests, 1);
  await assert.rejects(stat(cacheDir), /ENOENT/);
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp-")), []);
});

interface SyntheticTrust {
  readonly files: ReadonlyArray<{
    type: "file";
    path: string;
    oid: string;
    size: number;
    lfs?: { oid: string; size: number; pointerSize: number };
  }>;
  readonly mainSha256: string;
}

interface SourceCacheInternals {
  acquireSnapshotWithTrust(
    options: { cacheDir: string; publicDataPath?: string; fetch?: FetchLike },
    trust: SyntheticTrust,
  ): Promise<{ path: string; commit: string; fileCount: number; manifestSha256: string }>;
  verifySnapshotOfflineWithTrust(
    cacheDir: string,
    trust: SyntheticTrust,
  ): Promise<{ path: string; commit: string; fileCount: number; manifestSha256: string }>;
  removeStaging(staging: string, target: string): Promise<void>;
}

async function loadSourceCacheInternals(t: TestContext): Promise<SourceCacheInternals> {
  const moduleRoot = await mkdtemp(join(process.cwd(), ".source-cache-internals-"));
  t.after(() => rm(moduleRoot, { recursive: true, force: true }));
  await mkdir(join(moduleRoot, "src"));
  const compilerOptions = {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  } as const;
  const source = `${await readFile(new URL("../src/source-cache.ts", import.meta.url), "utf8")}\nexport { acquireSnapshotWithTrust, removeStaging, verifySnapshotOfflineWithTrust };\n`;
  const evalData = await readFile(new URL("../src/eval-data.ts", import.meta.url), "utf8");
  await writeFile(
    join(moduleRoot, "src", "source-cache.mjs"),
    ts.transpileModule(source, { compilerOptions }).outputText,
  );
  await writeFile(
    join(moduleRoot, "src", "eval-data.js"),
    ts.transpileModule(evalData, { compilerOptions }).outputText,
  );
  await writeFile(
    join(moduleRoot, "public-snapshot.json"),
    await readFile(new URL("../public-snapshot.json", import.meta.url)),
  );
  return import(`${pathToFileURL(join(moduleRoot, "src", "source-cache.mjs")).href}?${Date.now()}`) as Promise<SourceCacheInternals>;
}

test("refuses staging cleanup outside the exact target sibling pattern", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const root = await makeTempRoot(t);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "intact\n");
  await assert.rejects(
    internals.removeStaging(outside, join(root, "cache")),
    /unsafe.*cleanup/i,
  );
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "intact\n");
});

interface SyntheticFixture {
  readonly trust: SyntheticTrust;
  readonly bytes: Map<string, Buffer>;
  readonly databases: string[];
}

function syntheticPublicSnapshot(options: {
  readonly rowCount?: number;
  readonly selectedDatabases?: readonly string[];
} = {}): SyntheticFixture {
  const databases = [...new Set(TRACKED_PUBLIC_SNAPSHOT.files
    .filter((file) => file.path.includes("/"))
    .map((file) => file.path.split("/")[0]!))].sort();
  const bytes = new Map<string, Buffer>();
  bytes.set(".gitattributes", Buffer.from("fixture attributes\n"));
  bytes.set("README.md", Buffer.from("fixture readme\n"));
  for (const database of databases) {
    bytes.set(`${database}/${database}_column_meaning_base.json`, Buffer.from("{}\n"));
    bytes.set(`${database}/${database}_kb.jsonl`, Buffer.from('{"fixture":true}\n'));
    bytes.set(`${database}/${database}_schema.txt`, Buffer.from(`schema ${database}\n`));
  }
  const selectedDatabases = options.selectedDatabases ?? databases;
  const rows = Array.from({ length: options.rowCount ?? 300 }, (_, index) => ({
    instance_id: `public_fixture_${index + 1}`,
    selected_database: selectedDatabases[index % selectedDatabases.length],
    category: "Query",
    amb_user_query: `fixture question ${index + 1}`,
    follow_up: {},
  }));
  bytes.set("bird_interact_data.jsonl", Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`));
  const files = [...bytes]
    .map(([path, contents]) => ({
      type: "file" as const,
      path,
      oid: createHash("sha1").update(`blob ${contents.length}\0`).update(contents).digest("hex"),
      size: contents.length,
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const main = bytes.get("bird_interact_data.jsonl")!;
  return {
    trust: { files, mainSha256: createHash("sha256").update(main).digest("hex") },
    bytes,
    databases,
  };
}

function syntheticTree(fixture: SyntheticFixture, trust = fixture.trust): unknown[] {
  return [
    ...fixture.databases.map((path) => ({ type: "directory", path, oid: "0".repeat(40), size: 0 })),
    ...trust.files,
  ];
}

function resolvedFixturePath(url: string): string {
  const encoded = new URL(url).pathname.split(`/resolve/${HF_COMMIT}/`)[1];
  assert.ok(encoded);
  return encoded.split("/").map((segment) => decodeURIComponent(segment)).join("/");
}

test("rejects unsafe and duplicate paths directly in a custom trust manifest", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const fixture = syntheticPublicSnapshot();
  for (const unsafe of ["/absolute", "alien//empty", "alien/./dot", "alien/../parent", "alien\\backslash", "alien/nu\0l"]) {
    await t.test(JSON.stringify(unsafe), async (subtest) => {
      const root = await makeTempRoot(subtest);
      const trust: SyntheticTrust = {
        ...fixture.trust,
        files: fixture.trust.files.map((file) => file.path === "README.md" ? { ...file, path: unsafe } : file),
      };
      let requests = 0;
      await assert.rejects(
        internals.acquireSnapshotWithTrust({
          cacheDir: join(root, "cache"),
          fetch: async () => {
            requests += 1;
            return new Response("[]");
          },
        }, trust),
        /trust|manifest/i,
      );
      assert.equal(requests, 0);
    });
  }

  const duplicateTrust: SyntheticTrust = {
    ...fixture.trust,
    files: fixture.trust.files.map((file) => file.path === "README.md" ? { ...file, path: ".gitattributes" } : file),
  };
  await assert.rejects(
    internals.acquireSnapshotWithTrust({ cacheDir: join(await makeTempRoot(t), "duplicate"), fetch: async () => new Response("[]") }, duplicateTrust),
    /trust|manifest/i,
  );
});

test("acquires all 57 fake files, imports main by copy, and writes a canonical manifest", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const root = await makeTempRoot(t);
  const cacheDir = join(root, "bird-interact-lite");
  const publicDataPath = join(root, "public.jsonl");
  const fixture = syntheticPublicSnapshot();
  await writeFile(publicDataPath, fixture.bytes.get("bird_interact_data.jsonl")!);
  const tree = syntheticTree(fixture);
  const timeoutDelays: number[] = [];
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
  Object.defineProperty(AbortSignal, "timeout", {
    ...timeoutDescriptor,
    value: (delay: number) => {
      timeoutDelays.push(delay);
      return (timeoutDescriptor.value as (milliseconds: number) => AbortSignal)(delay);
    },
  });
  t.after(() => Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor));
  let treeRequests = 0;
  let fileRequests = 0;
  const fetcher: FetchLike = async (input, init) => {
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    const url = String(input);
    if (url.includes("/api/datasets/")) {
      treeRequests += 1;
      return new Response(JSON.stringify(tree));
    }
    fileRequests += 1;
    const path = resolvedFixturePath(url);
    const contents = fixture.bytes.get(path);
    assert.ok(contents, path);
    return new Response(new Uint8Array(contents), { headers: { "content-length": String(contents.length) } });
  };

  const acquired = await internals.acquireSnapshotWithTrust(
    { cacheDir, publicDataPath, fetch: fetcher },
    fixture.trust,
  );
  assert.equal(acquired.fileCount, 57);
  assert.equal(acquired.commit, HF_COMMIT);
  assert.equal(treeRequests, 1);
  assert.equal(fileRequests, 56);
  assert.deepEqual(timeoutDelays, Array.from({ length: 57 }, () => 120_000));
  const sourceStats = await stat(publicDataPath);
  const copiedStats = await stat(join(cacheDir, "bird_interact_data.jsonl"));
  assert.notDeepEqual([sourceStats.dev, sourceStats.ino], [copiedStats.dev, copiedStats.ino]);

  const manifest = await readFile(join(cacheDir, "_warble-source.json"), "utf8");
  const expectedManifest = `${JSON.stringify({
    repository: "https://huggingface.co/datasets/birdsql/bird-interact-lite",
    commit: "f7881a9c2b9630cc4fc13b0c39279740b0a2fd87",
    mainSha256: fixture.trust.mainSha256,
    files: fixture.trust.files.map((file) => ({
      type: file.type,
      path: file.path,
      oid: file.oid,
      size: file.size,
      sha256: createHash("sha256").update(fixture.bytes.get(file.path)!).digest("hex"),
    })),
  })}\n`;
  assert.equal(manifest, expectedManifest);
  assert.equal(createHash("sha256").update(expectedManifest).digest("hex"), "18de7308ec8be3c563530afcae91ccc8db315d3efa8c1489f3d6a18176745c44");
  assert.equal(acquired.manifestSha256, "18de7308ec8be3c563530afcae91ccc8db315d3efa8c1489f3d6a18176745c44");
  assert.deepEqual(await internals.verifySnapshotOfflineWithTrust(cacheDir, fixture.trust), acquired);

  const reused = await internals.acquireSnapshotWithTrust({ cacheDir, fetch: fetcher }, fixture.trust);
  assert.deepEqual(reused, acquired);
  assert.equal(treeRequests, 2);
  assert.equal(fileRequests, 56);
  assert.deepEqual(timeoutDelays, Array.from({ length: 58 }, () => 120_000));
});

test("validates a declared LFS pointer OID plus downloaded SHA-256 and size contract", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const root = await makeTempRoot(t);
  const fixture = syntheticPublicSnapshot();
  const lfsPath = "README.md";
  const contents = fixture.bytes.get(lfsPath)!;
  const lfsOid = createHash("sha256").update(contents).digest("hex");
  const pointer = Buffer.from(
    `version https://git-lfs.github.com/spec/v1\noid sha256:${lfsOid}\nsize ${contents.length}\n`,
  );
  const trust: SyntheticTrust = {
    ...fixture.trust,
    files: fixture.trust.files.map((file) => file.path === lfsPath ? {
      ...file,
      oid: createHash("sha1").update(`blob ${pointer.length}\0`).update(pointer).digest("hex"),
      lfs: { oid: lfsOid, size: contents.length, pointerSize: pointer.length },
    } : file),
  };
  const tree = [
    ...fixture.databases.map((path) => ({ type: "directory", path, oid: "0".repeat(40), size: 0 })),
    ...trust.files,
  ];
  const publicDataPath = join(root, "public.jsonl");
  await writeFile(publicDataPath, fixture.bytes.get("bird_interact_data.jsonl")!);
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("/api/datasets/")) return new Response(JSON.stringify(tree));
    const encodedPath = new URL(url).pathname.split(`/resolve/${HF_COMMIT}/`)[1]!;
    const path = encodedPath.split("/").map((segment) => decodeURIComponent(segment)).join("/");
    const body = fixture.bytes.get(path)!;
    return new Response(new Uint8Array(body), { headers: { "content-length": String(body.length) } });
  };

  const verified = await internals.acquireSnapshotWithTrust({
    cacheDir: join(root, "bird-interact-lite"),
    publicDataPath,
    fetch: fetcher,
  }, trust);
  assert.equal(verified.fileCount, 57);
});

test("rejects every invalid LFS content and pointer contract", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const fixture = syntheticPublicSnapshot();
  const lfsPath = "README.md";
  const contents = fixture.bytes.get(lfsPath)!;
  const makeTrust = (oid: string, size: number, pointerSizeOverride?: number): SyntheticTrust => {
    const pointer = Buffer.from(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`,
    );
    return {
      ...fixture.trust,
      files: fixture.trust.files.map((file) => file.path === lfsPath ? {
        ...file,
        size,
        oid: createHash("sha1").update(`blob ${pointer.length}\0`).update(pointer).digest("hex"),
        lfs: { oid, size, pointerSize: pointerSizeOverride ?? pointer.length },
      } : file),
    };
  };
  const contentSha = createHash("sha256").update(contents).digest("hex");
  const validTrust = makeTrust(contentSha, contents.length);
  const pointer = Buffer.from(
    `version https://git-lfs.github.com/spec/v1\noid sha256:${contentSha}\nsize ${contents.length}\n`,
  );
  const cases: ReadonlyArray<readonly [string, SyntheticTrust, Buffer]> = [
    ["wrong content SHA", makeTrust("f".repeat(64), contents.length), contents],
    ["wrong content size", makeTrust(contentSha, contents.length + 1), contents],
    ["malformed pointer size", makeTrust(contentSha, contents.length, pointer.length + 1), contents],
    ["pointer bytes served as content", validTrust, pointer],
  ];
  for (const [name, trust, lfsBody] of cases) {
    await t.test(name, async (subtest) => {
      const root = await makeTempRoot(subtest);
      const cacheDir = join(root, "cache");
      const publicDataPath = join(root, "public.jsonl");
      await writeFile(publicDataPath, fixture.bytes.get("bird_interact_data.jsonl")!);
      const fetcher: FetchLike = async (input) => {
        const url = String(input);
        if (url.includes("/api/datasets/")) return new Response(JSON.stringify(syntheticTree(fixture, trust)));
        const path = resolvedFixturePath(url);
        const body = path === lfsPath ? lfsBody : fixture.bytes.get(path)!;
        return new Response(new Uint8Array(body), { headers: { "content-length": String(body.length) } });
      };
      await assert.rejects(
        internals.acquireSnapshotWithTrust({ cacheDir, publicDataPath, fetch: fetcher }, trust),
        /LFS|size|trust|contract|SHA-256/i,
      );
      await assert.rejects(lstat(cacheDir), /ENOENT/);
      assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".tmp-")), []);
    });
  }
});

test("rejects every local metadata or manifest change offline and on online reuse without repair", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const fixture = syntheticPublicSnapshot();
  const tree = [
    ...fixture.databases.map((path) => ({ type: "directory", path, oid: "0".repeat(40), size: 0 })),
    ...fixture.trust.files,
  ];
  const cases: ReadonlyArray<readonly [
    string,
    (cacheDir: string) => Promise<void>,
    (cacheDir: string) => Promise<void>,
  ]> = [
    ["modified metadata", async (cacheDir) => {
      const path = join(cacheDir, "alien", "alien_schema.txt");
      const changed = await readFile(path);
      changed[0] = changed[0]! ^ 1;
      await writeFile(path, changed);
    }, async (cacheDir) => {
      assert.notDeepEqual(
        await readFile(join(cacheDir, "alien", "alien_schema.txt")),
        fixture.bytes.get("alien/alien_schema.txt"),
      );
    }],
    ["modified metadata with a canonical attack manifest", async (cacheDir) => {
      const relative = "alien/alien_schema.txt";
      const changed = await readFile(join(cacheDir, relative));
      changed[0] = changed[0]! ^ 1;
      await writeFile(join(cacheDir, relative), changed);
      const attackManifest = `${JSON.stringify({
        repository: HF_REPOSITORY,
        commit: HF_COMMIT,
        mainSha256: fixture.trust.mainSha256,
        files: fixture.trust.files.map((file) => {
          const body = file.path === relative ? changed : fixture.bytes.get(file.path)!;
          return {
            type: file.type,
            path: file.path,
            oid: file.oid,
            size: file.size,
            sha256: createHash("sha256").update(body).digest("hex"),
          };
        }),
      })}\n`;
      await writeFile(join(cacheDir, "_warble-source.json"), attackManifest);
    }, async (cacheDir) => {
      const manifest = JSON.parse(await readFile(join(cacheDir, "_warble-source.json"), "utf8")) as {
        files: Array<{ path: string; sha256: string }>;
      };
      const changed = await readFile(join(cacheDir, "alien", "alien_schema.txt"));
      assert.equal(
        manifest.files.find((file) => file.path === "alien/alien_schema.txt")?.sha256,
        createHash("sha256").update(changed).digest("hex"),
      );
    }],
    ["deleted metadata", async (cacheDir) => {
      await rm(join(cacheDir, "alien", "alien_kb.jsonl"));
    }, async (cacheDir) => {
      await assert.rejects(stat(join(cacheDir, "alien", "alien_kb.jsonl")), /ENOENT/);
    }],
    ["extra metadata", async (cacheDir) => {
      await writeFile(join(cacheDir, "alien", "extra.txt"), "tampered\n");
    }, async (cacheDir) => {
      assert.equal(await readFile(join(cacheDir, "alien", "extra.txt"), "utf8"), "tampered\n");
    }],
    ["corrupt manifest", async (cacheDir) => {
      await writeFile(join(cacheDir, "_warble-source.json"), "{}\n");
    }, async (cacheDir) => {
      assert.equal(await readFile(join(cacheDir, "_warble-source.json"), "utf8"), "{}\n");
    }],
  ];

  for (const [name, mutate, assertUnchanged] of cases) {
    await t.test(name, async (subtest) => {
      const root = await makeTempRoot(subtest);
      const cacheDir = join(root, "bird-interact-lite");
      const publicDataPath = join(root, "public.jsonl");
      await writeFile(publicDataPath, fixture.bytes.get("bird_interact_data.jsonl")!);
      let treeRequests = 0;
      let fileRequests = 0;
      const fetcher: FetchLike = async (input) => {
        const url = String(input);
        if (url.includes("/api/datasets/")) {
          treeRequests += 1;
          return new Response(JSON.stringify(tree));
        }
        fileRequests += 1;
        const encodedPath = new URL(url).pathname.split(`/resolve/${HF_COMMIT}/`)[1]!;
        const path = encodedPath.split("/").map((segment) => decodeURIComponent(segment)).join("/");
        const contents = fixture.bytes.get(path)!;
        return new Response(new Uint8Array(contents), { headers: { "content-length": String(contents.length) } });
      };
      await internals.acquireSnapshotWithTrust({ cacheDir, publicDataPath, fetch: fetcher }, fixture.trust);
      assert.equal(treeRequests, 1);
      assert.equal(fileRequests, 56);
      await mutate(cacheDir);

      await assert.rejects(
        internals.verifySnapshotOfflineWithTrust(cacheDir, fixture.trust),
        (error: unknown) => error instanceof Error && !error.message.includes("fixture question"),
      );
      await assert.rejects(
        internals.acquireSnapshotWithTrust({ cacheDir, fetch: fetcher }, fixture.trust),
        (error: unknown) => error instanceof Error && !error.message.includes("fixture question"),
      );
      assert.equal(treeRequests, 2);
      assert.equal(fileRequests, 56);
      await assertUnchanged(cacheDir);
    });
  }
});

test("rejects a same-size corrupt non-main download by its pinned Git blob OID", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const root = await makeTempRoot(t);
  const fixture = syntheticPublicSnapshot();
  const cacheDir = join(root, "cache");
  const publicDataPath = join(root, "public.jsonl");
  await writeFile(publicDataPath, fixture.bytes.get("bird_interact_data.jsonl")!);
  const corruptPath = "alien/alien_schema.txt";
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    if (url.includes("/api/datasets/")) return new Response(JSON.stringify(syntheticTree(fixture)));
    const path = resolvedFixturePath(url);
    const body = Buffer.from(fixture.bytes.get(path)!);
    if (path === corruptPath) body[0] = body[0]! ^ 1;
    return new Response(new Uint8Array(body));
  };
  await assert.rejects(
    internals.acquireSnapshotWithTrust({ cacheDir, publicDataPath, fetch: fetcher }, fixture.trust),
    /Git blob OID/i,
  );
  await assert.rejects(lstat(cacheDir), /ENOENT/);
  assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".tmp-")), []);
});

test("offline and online reuse reject symlink, hardlink, directory, and FIFO metadata without mutation", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const fixture = syntheticPublicSnapshot();
  const relative = "alien/alien_schema.txt";
  const cases: ReadonlyArray<readonly [string, (cacheDir: string, root: string) => Promise<void>]> = [
    ["symlink", async (cacheDir, root) => {
      const external = join(root, "external-symlink");
      await writeFile(external, fixture.bytes.get(relative)!);
      await rm(join(cacheDir, relative));
      await symlink(external, join(cacheDir, relative));
    }],
    ["hardlink", async (cacheDir, root) => {
      const external = join(root, "external-hardlink");
      await writeFile(external, fixture.bytes.get(relative)!);
      await rm(join(cacheDir, relative));
      await link(external, join(cacheDir, relative));
    }],
    ["directory", async (cacheDir) => {
      await rm(join(cacheDir, relative));
      await mkdir(join(cacheDir, relative));
    }],
    ["FIFO", async (cacheDir) => {
      const path = join(cacheDir, relative);
      await rm(path);
      await execFileAsync("mkfifo", [path], { timeout: 10_000 });
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const root = await makeTempRoot(subtest);
      const cacheDir = join(root, "cache");
      const publicDataPath = join(root, "public.jsonl");
      await writeFile(publicDataPath, fixture.bytes.get("bird_interact_data.jsonl")!);
      const downloadFetcher: FetchLike = async (input) => {
        const url = String(input);
        if (url.includes("/api/datasets/")) return new Response(JSON.stringify(syntheticTree(fixture)));
        return new Response(new Uint8Array(fixture.bytes.get(resolvedFixturePath(url))!));
      };
      await internals.acquireSnapshotWithTrust({ cacheDir, publicDataPath, fetch: downloadFetcher }, fixture.trust);
      await mutate(cacheDir, root);
      const before = await snapshotFilesystem(cacheDir);
      await assert.rejects(internals.verifySnapshotOfflineWithTrust(cacheDir, fixture.trust), /symlink|hardlink|file set|non-file|type|directory/i);
      let treeRequests = 0;
      await assert.rejects(
        internals.acquireSnapshotWithTrust({
          cacheDir,
          fetch: async () => {
            treeRequests += 1;
            return new Response(JSON.stringify(syntheticTree(fixture)));
          },
        }, fixture.trust),
        /symlink|hardlink|file set|non-file|type|directory/i,
      );
      assert.equal(treeRequests, 1);
      assert.deepEqual(await snapshotFilesystem(cacheDir), before);
    });
  }
});

test("rejects a symlink passed as the optional public JSONL source", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const root = await makeTempRoot(t);
  const fixture = syntheticPublicSnapshot();
  const realMain = join(root, "real-public.jsonl");
  const linkedMain = join(root, "linked-public.jsonl");
  await writeFile(realMain, fixture.bytes.get("bird_interact_data.jsonl")!);
  await symlink(realMain, linkedMain);
  const tree = [
    ...fixture.databases.map((path) => ({ type: "directory", path, oid: "0".repeat(40), size: 0 })),
    ...fixture.trust.files,
  ];
  const fetcher: FetchLike = async (input) => {
    assert.match(String(input), /\/api\/datasets\//);
    return new Response(JSON.stringify(tree));
  };

  await assert.rejects(
    internals.acquireSnapshotWithTrust({
      cacheDir: join(root, "bird-interact-lite"),
      publicDataPath: linkedMain,
      fetch: fetcher,
    }, fixture.trust),
    /symlink|regular file/i,
  );
});

test("rejects a same-size wrong optional public JSONL without linking or partial cache", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const root = await makeTempRoot(t);
  const fixture = syntheticPublicSnapshot();
  const wrongMain = Buffer.from(fixture.bytes.get("bird_interact_data.jsonl")!);
  wrongMain[wrongMain.length - 2] = wrongMain[wrongMain.length - 2]! ^ 1;
  const publicDataPath = join(root, "public.jsonl");
  await writeFile(publicDataPath, wrongMain);
  await assert.rejects(
    internals.acquireSnapshotWithTrust({
      cacheDir: join(root, "cache"),
      publicDataPath,
      fetch: async () => new Response(JSON.stringify(syntheticTree(fixture))),
    }, fixture.trust),
    /SHA-256|Git blob OID/i,
  );
  await assert.rejects(lstat(join(root, "cache")), /ENOENT/);
  assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".tmp-")), []);
});

test("rejects invalid public row counts, database admission, and missing metadata triplets", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const base = syntheticPublicSnapshot();
  const cases: ReadonlyArray<readonly [string, SyntheticFixture]> = [
    ["299 rows", syntheticPublicSnapshot({ rowCount: 299 })],
    ["301 rows", syntheticPublicSnapshot({ rowCount: 301 })],
    ["17 selected databases", syntheticPublicSnapshot({ selectedDatabases: base.databases.slice(0, 17) })],
    ["unknown selected database", syntheticPublicSnapshot({
      selectedDatabases: [...base.databases.slice(0, 17), "unknown_database"],
    })],
  ];
  for (const [name, fixture] of cases) {
    await t.test(name, async (subtest) => {
      const root = await makeTempRoot(subtest);
      const cacheDir = join(root, "cache");
      const publicDataPath = join(root, "public.jsonl");
      const outside = join(root, "outside-sentinel");
      await writeFile(publicDataPath, fixture.bytes.get("bird_interact_data.jsonl")!);
      await writeFile(outside, "intact\n");
      const fetcher: FetchLike = async (input) => {
        const url = String(input);
        if (url.includes("/api/datasets/")) return new Response(JSON.stringify(syntheticTree(fixture)));
        return new Response(new Uint8Array(fixture.bytes.get(resolvedFixturePath(url))!));
      };
      await assert.rejects(
        internals.acquireSnapshotWithTrust({ cacheDir, publicDataPath, fetch: fetcher }, fixture.trust),
        (error: unknown) => error instanceof Error &&
          /300|database|triplet|public/i.test(error.message) &&
          !error.message.includes("public_fixture") &&
          !error.message.includes("unknown_database"),
      );
      await assert.rejects(lstat(cacheDir), /ENOENT/);
      assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".tmp-")), []);
      assert.equal(await readFile(outside, "utf8"), "intact\n");
    });
  }

  const missingTriplet: SyntheticTrust = {
    ...base.trust,
    files: base.trust.files.filter((file) => file.path !== "alien/alien_kb.jsonl"),
  };
  const root = await makeTempRoot(t);
  let requests = 0;
  await assert.rejects(
    internals.acquireSnapshotWithTrust({
      cacheDir: join(root, "missing-triplet"),
      fetch: async () => {
        requests += 1;
        return new Response("[]");
      },
    }, missingTriplet),
    /trust|manifest|triplet/i,
  );
  assert.equal(requests, 0);
});

test("fetch rejection and aborted body streams clean late sibling staging without touching outside data", async (t) => {
  const internals = await loadSourceCacheInternals(t);
  const fixture = syntheticPublicSnapshot();
  for (const failure of ["fetch rejection", "aborted stream"] as const) {
    await t.test(failure, async (subtest) => {
      const root = await makeTempRoot(subtest);
      const cacheDir = join(root, "cache");
      const publicDataPath = join(root, "public.jsonl");
      const outside = join(root, "outside-sentinel");
      await writeFile(publicDataPath, fixture.bytes.get("bird_interact_data.jsonl")!);
      await writeFile(outside, "intact\n");
      let fileRequests = 0;
      const fetcher: FetchLike = async (input, init) => {
        assert.ok(init?.signal instanceof AbortSignal);
        const url = String(input);
        if (url.includes("/api/datasets/")) return new Response(JSON.stringify(syntheticTree(fixture)));
        fileRequests += 1;
        if (fileRequests === 6) {
          if (failure === "fetch rejection") throw new Error("DO_NOT_LEAK");
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.error(new DOMException("DO_NOT_LEAK", "AbortError"));
            },
          }));
        }
        return new Response(new Uint8Array(fixture.bytes.get(resolvedFixturePath(url))!));
      };
      await assert.rejects(
        internals.acquireSnapshotWithTrust({ cacheDir, publicDataPath, fetch: fetcher }, fixture.trust),
        (error: unknown) => error instanceof Error && !error.message.includes("DO_NOT_LEAK"),
      );
      assert.equal(fileRequests, 6);
      await assert.rejects(lstat(cacheDir), /ENOENT/);
      assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".tmp-")), []);
      assert.equal(await readFile(outside, "utf8"), "intact\n");
    });
  }
});

test("rejects unsafe, duplicate, or non-exact pinned tree listings", async (t) => {
  const unsafePaths = [
    "/absolute",
    "alien//empty",
    "alien/./dot",
    "alien/../parent",
    "alien\\backslash",
    "alien/nu\0l",
  ];
  const cases: Array<readonly [string, () => unknown[]]> = unsafePaths.map((path) => [
    `unsafe ${JSON.stringify(path)}`,
    () => officialTreeEntries().map((entry, index) => index === 18 ? { ...entry, path } : entry),
  ] as const);
  cases.push(
    ["duplicate path", () => {
      const entries = officialTreeEntries();
      return [...entries, { ...entries[20]! }];
    }],
    ["wrong oid", () => officialTreeEntries().map((entry, index) => index === 20 ? { ...entry, oid: "f".repeat(40) } : entry)],
    ["wrong size", () => officialTreeEntries().map((entry, index) => index === 20 ? { ...entry, size: entry.size + 1 } : entry)],
    ["wrong type", () => officialTreeEntries().map((entry, index) => index === 20 ? { ...entry, type: "directory" } : entry)],
    ["unexpected lfs", () => officialTreeEntries().map((entry, index) => index === 20 ? {
      ...entry,
      lfs: { oid: "a".repeat(64), size: entry.size, pointerSize: 128 },
    } : entry)],
    ["missing file", () => officialTreeEntries().slice(0, -1)],
  );

  for (const [name, entries] of cases) {
    await t.test(name, async (subtest) => {
      const root = await makeTempRoot(subtest);
      const cacheDir = join(root, "bird-interact-lite");
      const fetcher: FetchLike = async () => new Response(JSON.stringify(entries()));
      await assert.rejects(ensurePublicSnapshot({ cacheDir, fetch: fetcher }), /tree|schema|path|metadata/i);
      await assert.rejects(stat(cacheDir), /ENOENT/);
    });
  }
});

test("rejects off-origin or wrong-pin pagination and redirects", async (t) => {
  for (const next of [
    `https://evil.invalid/api/datasets/birdsql/bird-interact-lite/tree/${HF_COMMIT}?recursive=true&limit=1000`,
    "https://huggingface.co/api/datasets/birdsql/bird-interact-lite/tree/0000000000000000000000000000000000000000?recursive=true&limit=1000",
  ]) {
    await t.test(`pagination ${new URL(next).hostname}`, async (subtest) => {
      const root = await makeTempRoot(subtest);
      const fetcher: FetchLike = async () => new Response("[]", {
        headers: { link: `<${next}>; rel="next"` },
      });
      await assert.rejects(
        ensurePublicSnapshot({ cacheDir: join(root, "bird-interact-lite"), fetch: fetcher }),
        /pinned source/i,
      );
    });
  }

  await t.test("off-origin file redirect", async (subtest) => {
    const root = await makeTempRoot(subtest);
    let requests = 0;
    const fetcher: FetchLike = async (input) => {
      requests += 1;
      if (String(input).includes("/api/datasets/")) {
        return new Response(JSON.stringify(officialTreeEntries()));
      }
      return new Response(null, { status: 307, headers: { location: "https://evil.invalid/stolen" } });
    };
    await assert.rejects(
      ensurePublicSnapshot({ cacheDir: join(root, "bird-interact-lite"), fetch: fetcher }),
      /left the pinned source/i,
    );
    assert.equal(requests, 2);
  });

  await t.test("same-origin pinned file redirect", async (subtest) => {
    const root = await makeTempRoot(subtest);
    const requests: string[] = [];
    const fetcher: FetchLike = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/api/datasets/")) return new Response(JSON.stringify(officialTreeEntries()));
      if (url.includes("/resolve/")) {
        return new Response(null, {
          status: 307,
          headers: {
            location: `/api/resolve-cache/datasets/birdsql/bird-interact-lite/${HF_COMMIT}/bird_interact_data.jsonl`,
          },
        });
      }
      const bytes = Buffer.alloc(719_177, 0x61);
      return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
    };
    await assert.rejects(
      ensurePublicSnapshot({ cacheDir: join(root, "bird-interact-lite"), fetch: fetcher }),
      /SHA-256/i,
    );
    assert.equal(requests.length, 3);
  });
});

test("enforces the complete pinned tree pagination contract and page cap", async (t) => {
  const initial = `https://huggingface.co/api/datasets/birdsql/bird-interact-lite/tree/${HF_COMMIT}?recursive=true&limit=1000`;
  const validNext = `${initial}&cursor=next`;
  const cases: ReadonlyArray<readonly [string, (request: string, count: number) => Response, RegExp]> = [
    ["empty final page", () => new Response("[]"), /file set|directories/i],
    ["partial page missing next", () => new Response(JSON.stringify(officialTreeEntries().slice(0, 10))), /file set|directories/i],
    ["empty intermediate page", () => new Response("[]", { headers: { link: `<${validNext}>; rel="next"` } }), /empty intermediate/i],
    ["malformed next", () => new Response(JSON.stringify(officialTreeEntries().slice(0, 1)), { headers: { link: "<not a URL>; rel=next" } }), /pagination URL is invalid/i],
    ["multiple next links", () => new Response(JSON.stringify(officialTreeEntries().slice(0, 1)), {
      headers: { link: `<${validNext}>; rel=next, <${initial}&cursor=other>; rel=next` },
    }), /multiple next/i],
    ["looped next", () => new Response(JSON.stringify(officialTreeEntries().slice(0, 1)), { headers: { link: `<${initial}>; rel=next` } }), /looped|page limit/i],
    ["wrong repository", () => new Response(JSON.stringify(officialTreeEntries().slice(0, 1)), {
      headers: { link: `<https://huggingface.co/api/datasets/birdsql/other/tree/${HF_COMMIT}?recursive=true&limit=1000>; rel=next` },
    }), /pinned source/i],
    ["recursive false", () => new Response(JSON.stringify(officialTreeEntries().slice(0, 1)), {
      headers: { link: `<https://huggingface.co/api/datasets/birdsql/bird-interact-lite/tree/${HF_COMMIT}?recursive=false&limit=1000>; rel=next` },
    }), /not recursive/i],
    ["duplicate recursive", () => new Response(JSON.stringify(officialTreeEntries().slice(0, 1)), {
      headers: { link: `<${initial}&recursive=true>; rel=next` },
    }), /not recursive/i],
    ["unsafe limit", () => new Response(JSON.stringify(officialTreeEntries().slice(0, 1)), {
      headers: { link: `<https://huggingface.co/api/datasets/birdsql/bird-interact-lite/tree/${HF_COMMIT}?recursive=true&limit=1001>; rel=next` },
    }), /unsafe limit/i],
    ["unexpected query", () => new Response(JSON.stringify(officialTreeEntries().slice(0, 1)), {
      headers: { link: `<${initial}&token=secret>; rel=next` },
    }), /unexpected parameters/i],
  ];
  for (const [name, response, error] of cases) {
    await t.test(name, async (subtest) => {
      const root = await makeTempRoot(subtest);
      let requests = 0;
      await assert.rejects(
        ensurePublicSnapshot({
          cacheDir: join(root, "cache"),
          fetch: async (input) => response(String(input), ++requests),
        }),
        error,
      );
      assert.ok(requests >= 1);
      await assert.rejects(lstat(join(root, "cache")), /ENOENT/);
    });
  }

  await t.test("page cap", async (subtest) => {
    const root = await makeTempRoot(subtest);
    const entries = officialTreeEntries();
    let requests = 0;
    await assert.rejects(
      ensurePublicSnapshot({
        cacheDir: join(root, "cache"),
        fetch: async () => {
          const index = requests++;
          const next = `${initial}&cursor=page-${index + 1}`;
          return new Response(JSON.stringify([entries[index % entries.length]!]), {
            headers: { link: `<${next}>; rel=next` },
          });
        },
      }),
      /page limit/i,
    );
    assert.equal(requests, 75);
  });
});

test("bounds tree and file responses and validates status and declared size", async (t) => {
  const cases: ReadonlyArray<readonly [string, FetchLike, RegExp]> = [
    ["tree status", async () => new Response("unavailable", { status: 503 }), /status/i],
    ["tree bytes", async () => new Response("[]", { headers: { "content-length": String(3 * 1024 * 1024) } }), /byte limit/i],
    ["file status", async (input) => String(input).includes("/api/datasets/")
      ? new Response(JSON.stringify(officialTreeEntries()))
      : new Response("missing", { status: 404 }), /status/i],
    ["file declared size", async (input) => String(input).includes("/api/datasets/")
      ? new Response(JSON.stringify(officialTreeEntries()))
      : new Response("x", { headers: { "content-length": "719178" } }), /Content-Length|size/i],
  ];
  for (const [name, fetcher, expression] of cases) {
    await t.test(name, async (subtest) => {
      const root = await makeTempRoot(subtest);
      await assert.rejects(
        ensurePublicSnapshot({ cacheDir: join(root, "bird-interact-lite"), fetch: fetcher }),
        expression,
      );
      assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".tmp-")), []);
    });
  }
});

test("hashes the decoded Fetch body when Hugging Face serves standard compression", async (t) => {
  const root = await makeTempRoot(t);
  const fetcher: FetchLike = async (input) => {
    if (String(input).includes("/api/datasets/")) {
      return new Response(JSON.stringify(officialTreeEntries()));
    }
    return new Response(Buffer.alloc(719_177, 0x61), {
      headers: { "content-encoding": "gzip" },
    });
  };
  await assert.rejects(
    ensurePublicSnapshot({ cacheDir: join(root, "bird-interact-lite"), fetch: fetcher }),
    /SHA-256/i,
  );
});
