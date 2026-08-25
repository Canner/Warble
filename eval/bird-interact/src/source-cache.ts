import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { parsePublicJsonl } from "./eval-data.js";

export const BIRD_REPOSITORY = "https://github.com/bird-bench/BIRD-Interact.git";
export const BIRD_COMMIT = "451fe2c3518ee1cf908d8139e2913483bd519381";
export const HF_REPOSITORY = "https://huggingface.co/datasets/birdsql/bird-interact-lite";
export const HF_COMMIT = "f7881a9c2b9630cc4fc13b0c39279740b0a2fd87";
export const MAIN_PUBLIC_SHA256 = "d155fa0855bc1885f77df2fcc357d3056e10426cd6093c0042aa99d79067af08";
const HF_TREE_URL = `https://huggingface.co/api/datasets/birdsql/bird-interact-lite/tree/${HF_COMMIT}?recursive=true&limit=1000`;
const HF_RESOLVE_ROOT = `${HF_REPOSITORY}/resolve/${HF_COMMIT}`;

const MAIN_PUBLIC_PATH = "bird_interact_data.jsonl";
const TRUSTED_FILE_COUNT = 57;
const TRUSTED_DATABASE_COUNT = 18;
const GIT_TIMEOUT_MS = 120_000;
const HTTP_TIMEOUT_MS = 120_000;
const MAX_TREE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MANAGED_GIT_EXCLUDE = "/BIRD-Interact-ADK/.venv/\n/BIRD-Interact-ADK/bird-interact-lite\n";
const MANAGED_VENV_PATH = "BIRD-Interact-ADK/.venv";
const MANAGED_PUBLIC_DATA_PATH = "BIRD-Interact-ADK/bird-interact-lite";
const GIT_CONFIG_ARGUMENTS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.attributesFile=/dev/null",
] as const;
const SAFE_GIT_ENV: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/dev/null",
  XDG_CONFIG_HOME: "/dev/null",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
});
const REQUIRED_BIRD_FILES = [
  "BIRD-Interact-ADK/requirements.txt",
  "BIRD-Interact-ADK/shared/config.py",
  "BIRD-Interact-ADK/db_environment/server.py",
  "BIRD-Interact-ADK/user_simulator/server.py",
  "BIRD-Interact-ADK/orchestrator/runner.py",
] as const;

const execFileAsync = promisify(execFile);

export class SourceCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceCacheError";
  }
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => Promise<CommandResult>;

const defaultCommandRunner: CommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    encoding: "utf8",
    env: { ...options.env },
    maxBuffer: 1024 * 1024,
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export interface BirdCheckoutVerification {
  readonly path: string;
  readonly commit: typeof BIRD_COMMIT;
}

export interface VerifyBirdCheckoutOptions {
  readonly runner?: CommandRunner;
}

export interface EnsureBirdCheckoutOptions extends VerifyBirdCheckoutOptions {
  readonly cacheDir: string;
  readonly seedDir?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface EnsurePublicSnapshotOptions {
  readonly cacheDir: string;
  readonly publicDataPath?: string;
  readonly fetch?: FetchLike;
}

export interface PublicSnapshotVerification {
  readonly path: string;
  readonly repository: typeof HF_REPOSITORY;
  readonly commit: typeof HF_COMMIT;
  readonly fileCount: typeof TRUSTED_FILE_COUNT;
  readonly manifestSha256: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSafeRelativePath(value: string): boolean {
  if (value.includes("\0") || value.includes("\\") || posix.isAbsolute(value) || win32.isAbsolute(value)) {
    return false;
  }
  const segments = value.split("/");
  return segments.length > 0 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const lfsContractSchema = z.object({
  oid: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pointerSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

type LfsContract = z.infer<typeof lfsContractSchema>;

function lfsPointerBytes(contract: LfsContract): Buffer {
  return Buffer.from(
    `version https://git-lfs.github.com/spec/v1\noid sha256:${contract.oid}\nsize ${contract.size}\n`,
  );
}

const publicSnapshotFileSchema = z.object({
  type: z.literal("file"),
  path: z.string().refine(isSafeRelativePath),
  oid: z.string().regex(/^[0-9a-f]{40}$/),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lfs: lfsContractSchema.optional(),
}).strict();

const publicSnapshotSchema = z.object({
  repository: z.literal(HF_REPOSITORY),
  commit: z.literal(HF_COMMIT),
  files: z.array(publicSnapshotFileSchema).length(TRUSTED_FILE_COUNT),
}).strict().superRefine((snapshot, context) => {
  const paths = snapshot.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", message: "file paths must be unique" });
  }
  const sortedPaths = [...paths].sort(compareText);
  if (paths.some((path, index) => path !== sortedPaths[index])) {
    context.addIssue({ code: "custom", message: "files must be sorted by path" });
  }
  if (!paths.includes(MAIN_PUBLIC_PATH)) {
    context.addIssue({ code: "custom", message: "main public JSONL is missing" });
  }
  for (const file of snapshot.files) {
    if (file.lfs === undefined) continue;
    const pointer = lfsPointerBytes(file.lfs);
    const pointerOid = createHash("sha1").update(`blob ${pointer.length}\0`).update(pointer).digest("hex");
    if (file.size !== file.lfs.size || file.lfs.pointerSize !== pointer.length || file.oid !== pointerOid) {
      context.addIssue({ code: "custom", message: "LFS contract does not match its Git pointer" });
    }
  }

  const pathSet = new Set(paths);
  const databases = paths
    .filter((path) => path.endsWith("_schema.txt") && path.split("/").length === 2)
    .map((path) => path.split("/")[0]!);
  if (databases.length !== TRUSTED_DATABASE_COUNT || new Set(databases).size !== TRUSTED_DATABASE_COUNT) {
    context.addIssue({ code: "custom", message: "metadata must cover exactly 18 databases" });
  }
  for (const database of databases) {
    for (const suffix of ["_schema.txt", "_column_meaning_base.json", "_kb.jsonl"]) {
      if (!pathSet.has(`${database}/${database}${suffix}`)) {
        context.addIssue({ code: "custom", message: "database metadata triplet is incomplete" });
      }
    }
  }
});

interface PublicSnapshotFile {
  readonly type: "file";
  readonly path: string;
  readonly oid: string;
  readonly size: number;
  readonly lfs?: LfsContract | undefined;
}

interface PublicSnapshot {
  readonly repository: typeof HF_REPOSITORY;
  readonly commit: typeof HF_COMMIT;
  readonly files: readonly PublicSnapshotFile[];
}

function loadPublicSnapshot(): PublicSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(new URL("../public-snapshot.json", import.meta.url), "utf8"));
  } catch {
    throw new Error("Tracked public source manifest is not valid JSON");
  }
  const parsed = publicSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Tracked public source manifest violates the pinned source contract");
  }
  const files = Object.freeze(parsed.data.files.map((file) => Object.freeze(file)));
  return Object.freeze({
    repository: parsed.data.repository,
    commit: parsed.data.commit,
    files,
  });
}

const publicSnapshot = loadPublicSnapshot();

// Official BIRD Git checkout verification and atomic cache acquisition.
function isOfficialBirdOrigin(origin: string): boolean {
  if (/^git@github\.com:bird-bench\/BIRD-Interact(?:\.git)?\/?$/.test(origin)) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.hostname !== "github.com" || url.port !== "" || url.search !== "" || url.hash !== "") {
    return false;
  }
  if (!/^\/bird-bench\/BIRD-Interact(?:\.git)?\/?$/.test(url.pathname)) {
    return false;
  }
  if (url.protocol === "https:") {
    return url.username === "" && url.password === "";
  }
  return url.protocol === "ssh:" && url.username === "git" && url.password === "";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function runGit(
  runner: CommandRunner,
  cwd: string,
  args: readonly string[],
): Promise<CommandResult> {
  try {
    return await runner("git", [...GIT_CONFIG_ARGUMENTS, ...args], {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      env: SAFE_GIT_ENV,
    });
  } catch {
    throw new SourceCacheError("Official BIRD Git verification command failed");
  }
}

function singleGitLine(output: string, label: string): string {
  const normalized = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (normalized === "" || normalized.includes("\n") || normalized.includes("\r")) {
    throw new SourceCacheError(`Official BIRD checkout has invalid ${label} metadata`);
  }
  return normalized;
}

function nullTerminatedGitRecords(output: string, label: string): string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) {
    throw new SourceCacheError(`Official BIRD checkout has malformed ${label} metadata`);
  }
  const records = output.slice(0, -1).split("\0");
  if (records.some((record) => record === "")) {
    throw new SourceCacheError(`Official BIRD checkout has malformed ${label} metadata`);
  }
  return records;
}

interface GitTrackedEntry {
  readonly path: string;
  readonly mode: "100644" | "100755" | "120000";
  readonly oid: string;
}

function parseHeadTree(output: string): GitTrackedEntry[] {
  const entries: GitTrackedEntry[] = [];
  for (const record of nullTerminatedGitRecords(output, "HEAD tree")) {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
    if (match === null || !isSafeRelativePath(match[3]!)) {
      throw new SourceCacheError("Official BIRD HEAD tree contains an unsupported or unsafe entry");
    }
    entries.push({ mode: match[1]! as GitTrackedEntry["mode"], oid: match[2]!, path: match[3]! });
  }
  return entries;
}

function parseIndex(output: string): GitTrackedEntry[] {
  const entries: GitTrackedEntry[] = [];
  for (const record of nullTerminatedGitRecords(output, "index")) {
    const match = /^(100644|100755|120000) ([0-9a-f]{40}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (match === null || match[3] !== "0" || !isSafeRelativePath(match[4]!)) {
      throw new SourceCacheError("Official BIRD index contains an unsupported, conflicted, or unsafe entry");
    }
    entries.push({ mode: match[1]! as GitTrackedEntry["mode"], oid: match[2]!, path: match[4]! });
  }
  return entries;
}

function indexEntriesByPath(entries: readonly GitTrackedEntry[], label: string): Map<string, GitTrackedEntry> {
  const result = new Map<string, GitTrackedEntry>();
  for (const entry of entries) {
    if (result.has(entry.path)) {
      throw new SourceCacheError(`Official BIRD ${label} contains duplicate paths`);
    }
    result.set(entry.path, entry);
  }
  return result;
}

function assertExactIndex(head: readonly GitTrackedEntry[], index: readonly GitTrackedEntry[]): void {
  const headByPath = indexEntriesByPath(head, "HEAD tree");
  const indexByPath = indexEntriesByPath(index, "index");
  if (headByPath.size !== indexByPath.size) {
    throw new SourceCacheError("Official BIRD index differs from the pinned HEAD tree");
  }
  for (const [path, expected] of headByPath) {
    const actual = indexByPath.get(path);
    if (actual === undefined || actual.mode !== expected.mode || actual.oid !== expected.oid) {
      throw new SourceCacheError("Official BIRD index differs from the pinned HEAD tree");
    }
  }
}

function assertNoIndexFlags(output: string, trackedPaths: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const record of nullTerminatedGitRecords(output, "index flags")) {
    if (!record.startsWith("H ")) {
      throw new SourceCacheError("Official BIRD index uses assume-unchanged, skip-worktree, or unsupported flags");
    }
    const path = record.slice(2);
    if (!isSafeRelativePath(path) || !trackedPaths.has(path) || seen.has(path)) {
      throw new SourceCacheError("Official BIRD index flags do not match its HEAD tree");
    }
    seen.add(path);
  }
  if (seen.size !== trackedPaths.size) {
    throw new SourceCacheError("Official BIRD index flags do not match its HEAD tree");
  }
}

async function gitBlobOidForWorktreeEntry(root: string, entry: GitTrackedEntry): Promise<string> {
  const absolute = join(root, ...entry.path.split("/"));
  let details;
  try {
    details = await lstat(absolute);
  } catch {
    throw new SourceCacheError("Official BIRD worktree is missing a tracked entry");
  }

  let bytes: Buffer;
  if (entry.mode === "120000") {
    if (!details.isSymbolicLink() || details.nlink !== 1) {
      throw new SourceCacheError("Official BIRD worktree has a tracked type or hardlink mismatch");
    }
    try {
      bytes = await readlink(absolute, { encoding: "buffer" });
    } catch {
      throw new SourceCacheError("Official BIRD worktree symlink could not be read safely");
    }
  } else {
    const actualMode = details.mode & 0o111 ? "100755" : "100644";
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || actualMode !== entry.mode) {
      throw new SourceCacheError("Official BIRD worktree has a tracked type, mode, or hardlink mismatch");
    }
    let handle;
    try {
      handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new SourceCacheError("Official BIRD worktree file could not be opened safely");
    }
    try {
      const opened = await handle.stat();
      const openedMode = opened.mode & 0o111 ? "100755" : "100644";
      if (
        !opened.isFile() || opened.nlink !== 1 || openedMode !== entry.mode ||
        opened.dev !== details.dev || opened.ino !== details.ino
      ) {
        throw new SourceCacheError("Official BIRD worktree file changed while it was inspected");
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function trackedDirectories(entries: readonly GitTrackedEntry[]): Set<string> {
  const directories = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

async function verifyWorktreeEntries(
  root: string,
  tracked: readonly GitTrackedEntry[],
  managed: boolean,
): Promise<void> {
  const trackedByPath = indexEntriesByPath(tracked, "HEAD tree");
  for (const entry of tracked) {
    if (await gitBlobOidForWorktreeEntry(root, entry) !== entry.oid) {
      throw new SourceCacheError("Official BIRD worktree bytes differ from the pinned HEAD tree");
    }
  }

  const allowedDirectories = trackedDirectories(tracked);
  const walk = async (relative = ""): Promise<void> => {
    const absolute = relative === "" ? root : join(root, ...relative.split("/"));
    for (const directoryEntry of await readdir(absolute, { withFileTypes: true })) {
      if (relative === "" && directoryEntry.name === ".git") continue;
      const child = relative === "" ? directoryEntry.name : `${relative}/${directoryEntry.name}`;
      if (!isSafeRelativePath(child)) {
        throw new SourceCacheError("Official BIRD worktree contains an unsafe entry");
      }
      const details = await lstat(join(root, ...child.split("/")));
      if (managed && child === MANAGED_VENV_PATH) {
        if (!details.isDirectory() || details.isSymbolicLink()) {
          throw new SourceCacheError("Official BIRD managed virtualenv entry must be a real directory");
        }
        continue;
      }
      if (managed && child === MANAGED_PUBLIC_DATA_PATH) {
        if (!details.isSymbolicLink()) {
          throw new SourceCacheError("Official BIRD managed public-data entry must be the exact symlink");
        }
        continue;
      }
      if (trackedByPath.has(child)) continue;
      if (details.isDirectory() && !details.isSymbolicLink() && allowedDirectories.has(child)) {
        await walk(child);
        continue;
      }
      throw new SourceCacheError("Official BIRD worktree contains an unexpected runtime or untracked entry");
    }
  };
  await walk();
}

function verifyRequiredBirdEntries(entries: readonly GitTrackedEntry[]): void {
  const tracked = indexEntriesByPath(entries, "HEAD tree");
  for (const path of REQUIRED_BIRD_FILES) {
    const entry = tracked.get(path);
    if (entry === undefined) {
      throw new SourceCacheError(`Official BIRD checkout is missing required file ${path}`);
    }
    if (entry.mode === "120000") {
      throw new SourceCacheError(`Official BIRD checkout has an invalid required file ${path}`);
    }
  }
}

async function verifyBirdCheckoutInternal(
  checkoutDir: string,
  runner: CommandRunner,
  managed: boolean,
): Promise<BirdCheckoutVerification> {
  const root = resolve(checkoutDir);
  let rootDetails;
  try {
    rootDetails = await lstat(root);
  } catch {
    throw new SourceCacheError("Official BIRD checkout does not exist");
  }
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new SourceCacheError("Official BIRD checkout must be a real directory");
  }

  if (managed) {
    let exclude: string;
    try {
      exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    } catch {
      throw new SourceCacheError("Official BIRD cache is missing its managed Git exclusions");
    }
    if (exclude !== MANAGED_GIT_EXCLUDE) {
      throw new SourceCacheError("Official BIRD cache has unexpected Git exclusions");
    }
  }

  const origin = singleGitLine(
    (await runGit(runner, root, ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"])).stdout,
    "origin",
  );
  if (!isOfficialBirdOrigin(origin)) {
    throw new SourceCacheError("Official BIRD checkout has an unexpected origin");
  }
  const head = singleGitLine((await runGit(runner, root, ["rev-parse", "HEAD"])).stdout, "HEAD");
  if (head !== BIRD_COMMIT) {
    throw new SourceCacheError("Official BIRD checkout is not at the pinned commit");
  }
  const branch = singleGitLine(
    (await runGit(runner, root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout,
    "HEAD attachment",
  );
  if (branch !== "HEAD") {
    throw new SourceCacheError("Official BIRD checkout must have a detached HEAD");
  }
  const headTree = parseHeadTree((await runGit(runner, root, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"])).stdout);
  const index = parseIndex((await runGit(runner, root, ["ls-files", "--stage", "-z", "--"])).stdout);
  assertExactIndex(headTree, index);
  assertNoIndexFlags(
    (await runGit(runner, root, ["ls-files", "-v", "-z", "--"])).stdout,
    new Set(headTree.map((entry) => entry.path)),
  );
  verifyRequiredBirdEntries(headTree);
  await verifyWorktreeEntries(root, headTree, managed);
  return { path: root, commit: BIRD_COMMIT };
}

export async function verifyBirdCheckout(
  checkoutDir: string,
  options: VerifyBirdCheckoutOptions = {},
): Promise<BirdCheckoutVerification> {
  return verifyBirdCheckoutInternal(checkoutDir, options.runner ?? defaultCommandRunner, true);
}

function stagingPathFor(target: string): string {
  const parent = dirname(target);
  const staging = join(parent, `.${basename(target)}.tmp-${randomUUID()}`);
  if (dirname(staging) !== parent || staging === target) {
    throw new SourceCacheError("Refusing an unsafe source-cache staging path");
  }
  return staging;
}

async function removeStaging(staging: string, target: string): Promise<void> {
  if (dirname(staging) !== dirname(target) || staging === target || !basename(staging).startsWith(`.${basename(target)}.tmp-`)) {
    throw new SourceCacheError("Refusing unsafe source-cache staging cleanup");
  }
  await rm(staging, { recursive: true, force: true });
}

export async function ensureBirdCheckout(
  options: EnsureBirdCheckoutOptions,
): Promise<BirdCheckoutVerification> {
  const target = resolve(options.cacheDir);
  const runner = options.runner ?? defaultCommandRunner;
  if (await pathExists(target)) {
    return verifyBirdCheckoutInternal(target, runner, true);
  }

  let source = BIRD_REPOSITORY;
  if (options.seedDir !== undefined) {
    const seed = resolve(options.seedDir);
    await verifyBirdCheckoutInternal(seed, runner, false);
    source = seed;
  }

  await mkdir(dirname(target), { recursive: true });
  const staging = stagingPathFor(target);
  try {
    await runGit(runner, dirname(target), ["clone", "--no-hardlinks", source, staging]);
    await runGit(runner, staging, ["remote", "set-url", "origin", BIRD_REPOSITORY]);
    await runGit(runner, staging, ["checkout", "--detach", BIRD_COMMIT]);
    await writeFile(join(staging, ".git", "info", "exclude"), MANAGED_GIT_EXCLUDE, { encoding: "utf8", mode: 0o644 });
    const verified = await verifyBirdCheckoutInternal(staging, runner, true);
    if (await pathExists(target)) {
      throw new SourceCacheError("Official BIRD cache appeared while acquisition was in progress");
    }
    await rename(staging, target);
    return { ...verified, path: target };
  } catch (error) {
    await removeStaging(staging, target);
    if (error instanceof SourceCacheError) throw error;
    throw new SourceCacheError("Failed to acquire the official BIRD checkout");
  }
}

const treeEntrySchema = z.object({
  type: z.enum(["file", "directory"]),
  path: z.string().refine(isSafeRelativePath),
  oid: z.string().regex(/^[0-9a-f]{40}$/),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lfs: lfsContractSchema.optional(),
}).passthrough();

type TreeEntry = z.infer<typeof treeEntrySchema>;

interface VerifiedFile extends PublicSnapshotFile {
  readonly sha256: string;
}

interface SnapshotTrust {
  readonly files: readonly PublicSnapshotFile[];
  readonly mainSha256: string;
}

const OFFICIAL_SNAPSHOT_TRUST: SnapshotTrust = Object.freeze({
  files: publicSnapshot.files,
  mainSha256: MAIN_PUBLIC_SHA256,
});

// Pinned Hugging Face tree enumeration and bounded content acquisition.
function validateTreePageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceCacheError("Hugging Face tree pagination URL is invalid");
  }
  const expectedPath = `/api/datasets/birdsql/bird-interact-lite/tree/${HF_COMMIT}`;
  if (
    url.origin !== "https://huggingface.co" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== expectedPath ||
    url.hash !== ""
  ) {
    throw new SourceCacheError("Hugging Face tree pagination left the pinned source");
  }
  const allowedParameters = new Set(["recursive", "limit", "cursor", "expand"]);
  if ([...url.searchParams.keys()].some((key) => !allowedParameters.has(key))) {
    throw new SourceCacheError("Hugging Face tree pagination contains unexpected parameters");
  }
  if (url.searchParams.getAll("recursive").length !== 1 || url.searchParams.get("recursive") !== "true") {
    throw new SourceCacheError("Hugging Face tree pagination is not recursive");
  }
  const limits = url.searchParams.getAll("limit");
  const limit = limits.length === 1 ? Number(limits[0]) : Number.NaN;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
    throw new SourceCacheError("Hugging Face tree pagination has an unsafe limit");
  }
  if (url.searchParams.getAll("cursor").length > 1 || url.searchParams.getAll("expand").length > 1) {
    throw new SourceCacheError("Hugging Face tree pagination has duplicate parameters");
  }
  if (url.searchParams.has("expand") && url.searchParams.get("expand") !== "false") {
    throw new SourceCacheError("Hugging Face tree pagination requested an expanded response");
  }
  return url;
}

async function fetchOnce(fetcher: FetchLike, url: string): Promise<Response> {
  try {
    return await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch {
    throw new SourceCacheError("Hugging Face request failed or timed out");
  }
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new SourceCacheError("Hugging Face response has an invalid Content-Length");
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw new SourceCacheError("Hugging Face response Content-Length is unsafe");
  }
  return length;
}

function hasEncodedBody(response: Response): boolean {
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && !["identity", "gzip", "deflate", "br"].includes(encoding)) {
    throw new SourceCacheError("Hugging Face response used unexpected content encoding");
  }
  return encoding !== null && encoding !== "identity";
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const encoded = hasEncodedBody(response);
  const declared = contentLength(response);
  if (declared !== undefined && declared > maximumBytes) {
    throw new SourceCacheError("Hugging Face response exceeds the byte limit");
  }
  if (response.body === null) {
    throw new SourceCacheError("Hugging Face response has no body");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new SourceCacheError("Hugging Face response exceeds the byte limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!encoded && declared !== undefined && total !== declared) {
    throw new SourceCacheError("Hugging Face response size disagrees with Content-Length");
  }
  return Buffer.concat(chunks, total);
}

function nextLink(response: Response): string | undefined {
  const link = response.headers.get("link");
  if (link === null) return undefined;
  const matches = [...link.matchAll(/<([^>]+)>\s*;\s*rel="?next"?/g)];
  if (matches.length > 1) {
    throw new SourceCacheError("Hugging Face tree response has multiple next links");
  }
  return matches[0]?.[1];
}

function trustedDatabaseNames(trust: SnapshotTrust): string[] {
  return trust.files
    .filter((file) => file.path.endsWith("_schema.txt"))
    .map((file) => file.path.split("/")[0]!)
    .sort(compareText);
}

function validateOfficialTree(entries: readonly TreeEntry[], trust: SnapshotTrust): TreeEntry[] {
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new SourceCacheError("Hugging Face tree contains duplicate paths");
  }
  const files = entries
    .filter((entry) => entry.type === "file")
    .sort((left, right) => compareText(left.path, right.path));
  if (files.length !== trust.files.length) {
    throw new SourceCacheError("Hugging Face tree file set differs from the tracked trust root");
  }
  for (let index = 0; index < trust.files.length; index += 1) {
    const actual = files[index]!;
    const expected = trust.files[index]!;
    const sameLfs = actual.lfs === undefined && expected.lfs === undefined ||
      actual.lfs !== undefined && expected.lfs !== undefined &&
      actual.lfs.oid === expected.lfs.oid &&
      actual.lfs.size === expected.lfs.size &&
      actual.lfs.pointerSize === expected.lfs.pointerSize;
    if (
      actual.type !== expected.type ||
      actual.path !== expected.path ||
      actual.oid !== expected.oid ||
      actual.size !== expected.size ||
      !sameLfs
    ) {
      throw new SourceCacheError("Hugging Face tree file metadata differs from the tracked trust root");
    }
  }
  const directories = entries
    .filter((entry) => entry.type === "directory")
    .map((entry) => entry.path)
    .sort(compareText);
  const expectedDirectories = trustedDatabaseNames(trust);
  if (
    directories.length !== expectedDirectories.length ||
    directories.some((directory, index) => directory !== expectedDirectories[index])
  ) {
    throw new SourceCacheError("Hugging Face tree database directories differ from the pinned snapshot");
  }
  return files;
}

async function enumerateOfficialTree(fetcher: FetchLike, trust: SnapshotTrust): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const visited = new Set<string>();
  // Empty intermediate pages are rejected below, so every page contributes at least one entry and
  // the pinned entry ceiling doubles as the page ceiling.
  const maximumEntries = trust.files.length + TRUSTED_DATABASE_COUNT;
  let next: string | undefined = HF_TREE_URL;
  while (next !== undefined) {
    const url = validateTreePageUrl(next).toString();
    if (visited.has(url) || visited.size >= maximumEntries) {
      throw new SourceCacheError("Hugging Face tree pagination looped or exceeded its page limit");
    }
    visited.add(url);
    const response = await fetchOnce(fetcher, url);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new SourceCacheError("Hugging Face tree request redirected unexpectedly");
    }
    if (response.status !== 200) {
      throw new SourceCacheError("Hugging Face tree request returned an unexpected status");
    }
    if (response.url !== "") validateTreePageUrl(response.url);
    const bytes = await readBoundedResponse(response, MAX_TREE_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new SourceCacheError("Hugging Face tree response is not valid JSON");
    }
    const parsed = z.array(treeEntrySchema).safeParse(value);
    if (!parsed.success) {
      throw new SourceCacheError("Hugging Face tree response violates the pinned schema");
    }
    const pageNext = nextLink(response);
    if (pageNext !== undefined) validateTreePageUrl(pageNext);
    if (parsed.data.length === 0 && pageNext !== undefined) {
      throw new SourceCacheError("Hugging Face tree pagination returned an empty intermediate page");
    }
    entries.push(...parsed.data);
    if (entries.length > maximumEntries) {
      throw new SourceCacheError("Hugging Face tree contains more entries than the pinned snapshot");
    }
    next = pageNext;
  }
  return validateOfficialTree(entries, trust);
}

function localSnapshotPath(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) {
    throw new SourceCacheError("Refusing an unsafe public snapshot path");
  }
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, ...relative.split("/"));
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new SourceCacheError("Refusing a public snapshot path outside its staging root");
  }
  return candidate;
}

async function readBoundedRegularFile(
  path: string,
  options: {
    readonly label: string;
    readonly maximumBytes: number;
    readonly expectedSize?: number;
    readonly requireSingleLink: boolean;
  },
): Promise<Buffer> {
  let initial;
  try {
    initial = await lstat(path);
  } catch {
    throw new SourceCacheError(`${options.label} could not be inspected`);
  }
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new SourceCacheError(`${options.label} must be a real regular file, not a symlink`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new SourceCacheError(`${options.label} could not be opened safely`);
  }
  try {
    const details = await handle.stat();
    if (
      !details.isFile() ||
      details.size > options.maximumBytes ||
      (options.expectedSize !== undefined && details.size !== options.expectedSize) ||
      (options.requireSingleLink && details.nlink !== 1)
    ) {
      throw new SourceCacheError(`${options.label} has an unexpected type, size, or link count`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== details.size || bytes.length > options.maximumBytes) {
      throw new SourceCacheError(`${options.label} changed while it was being read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function resolveUrlFor(path: string): string {
  if (!isSafeRelativePath(path)) {
    throw new SourceCacheError("Refusing an unsafe Hugging Face file path");
  }
  return `${HF_RESOLVE_ROOT}/${path.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function validateResolveUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceCacheError("Hugging Face resolve URL is invalid");
  }
  const resolvePrefix = `/datasets/birdsql/bird-interact-lite/resolve/${HF_COMMIT}/`;
  const cachePrefix = `/api/resolve-cache/datasets/birdsql/bird-interact-lite/${HF_COMMIT}/`;
  if (
    url.origin !== "https://huggingface.co" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (!url.pathname.startsWith(resolvePrefix) && !url.pathname.startsWith(cachePrefix))
  ) {
    throw new SourceCacheError("Hugging Face file redirect left the pinned source");
  }
  return url;
}

async function fetchResolvedFile(fetcher: FetchLike, initialUrl: string): Promise<Response> {
  let current = validateResolveUrl(initialUrl).toString();
  const visited = new Set<string>();
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (visited.has(current)) {
      throw new SourceCacheError("Hugging Face file redirect looped");
    }
    visited.add(current);
    const response = await fetchOnce(fetcher, current);
    if (response.redirected) {
      throw new SourceCacheError("Hugging Face fetch followed a redirect automatically");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        throw new SourceCacheError("Hugging Face file redirect has no destination");
      }
      current = validateResolveUrl(new URL(location, current).toString()).toString();
      continue;
    }
    if (response.status !== 200) {
      throw new SourceCacheError("Hugging Face file request returned an unexpected status");
    }
    if (response.url !== "") validateResolveUrl(response.url);
    return response;
  }
  throw new SourceCacheError("Hugging Face file exceeded its redirect limit");
}

function assertFileDigests(
  expected: PublicSnapshotFile,
  actualSha256: string,
  actualGitOid: string,
  mainSha256: string,
): void {
  if (expected.path === MAIN_PUBLIC_PATH && actualSha256 !== mainSha256) {
    throw new SourceCacheError("Main public JSONL SHA-256 differs from the pinned digest");
  }
  let comparableGitOid = actualGitOid;
  if (expected.lfs !== undefined) {
    if (expected.size !== expected.lfs.size || actualSha256 !== expected.lfs.oid) {
      throw new SourceCacheError("Hugging Face LFS content differs from its SHA-256 or size contract");
    }
    const pointer = lfsPointerBytes(expected.lfs);
    if (pointer.length !== expected.lfs.pointerSize) {
      throw new SourceCacheError("Hugging Face LFS pointer size differs from its contract");
    }
    comparableGitOid = createHash("sha1")
      .update(`blob ${pointer.length}\0`)
      .update(pointer)
      .digest("hex");
  }
  if (comparableGitOid !== expected.oid) {
    throw new SourceCacheError("Hugging Face file Git blob OID differs from the pinned tree");
  }
}

async function writeResponseFile(
  response: Response,
  destination: string,
  expected: PublicSnapshotFile,
  mainSha256: string,
): Promise<VerifiedFile> {
  const encoded = hasEncodedBody(response);
  const declared = contentLength(response);
  if (!encoded && declared !== undefined && declared !== expected.size) {
    throw new SourceCacheError("Hugging Face file Content-Length differs from the pinned size");
  }
  if (encoded && declared !== undefined && declared > MAX_FILE_BYTES) {
    throw new SourceCacheError("Hugging Face encoded file exceeds the byte limit");
  }
  if (expected.size > MAX_FILE_BYTES) {
    throw new SourceCacheError("Pinned Hugging Face file exceeds the per-file byte limit");
  }
  if (response.body === null) {
    throw new SourceCacheError("Hugging Face file response has no body");
  }

  await mkdir(dirname(destination), { recursive: true });
  const handle = await open(destination, "wx", 0o644);
  const sha256 = createHash("sha256");
  const gitOid = createHash("sha1").update(`blob ${expected.size}\0`);
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expected.size || size > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new SourceCacheError("Hugging Face file exceeded its pinned size or byte limit");
      }
      const chunk = Buffer.from(value);
      sha256.update(chunk);
      gitOid.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const written = await handle.write(chunk, offset, chunk.length - offset, null);
        if (written.bytesWritten <= 0) {
          throw new SourceCacheError("Failed to write the public snapshot staging file");
        }
        offset += written.bytesWritten;
      }
    }
  } finally {
    reader.releaseLock();
    await handle.close();
  }

  if (size !== expected.size || (!encoded && declared !== undefined && size !== declared)) {
    throw new SourceCacheError("Hugging Face file size differs from the pinned size");
  }
  const actualSha256 = sha256.digest("hex");
  const actualOid = gitOid.digest("hex");
  assertFileDigests(expected, actualSha256, actualOid, mainSha256);
  return { ...expected, sha256: actualSha256 };
}

async function downloadOfficialFile(
  fetcher: FetchLike,
  staging: string,
  expected: PublicSnapshotFile,
  mainSha256: string,
): Promise<VerifiedFile> {
  const response = await fetchResolvedFile(fetcher, resolveUrlFor(expected.path));
  return writeResponseFile(response, localSnapshotPath(staging, expected.path), expected, mainSha256);
}

const internalManifestFileSchema = publicSnapshotFileSchema.extend({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).omit({ lfs: true }).strict();

const internalManifestSchema = z.object({
  repository: z.literal(HF_REPOSITORY),
  commit: z.literal(HF_COMMIT),
  mainSha256: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.array(internalManifestFileSchema).length(TRUSTED_FILE_COUNT),
}).strict();

function validateSnapshotTrust(trust: SnapshotTrust): void {
  const parsed = publicSnapshotSchema.safeParse({
    repository: HF_REPOSITORY,
    commit: HF_COMMIT,
    files: trust.files,
  });
  if (!parsed.success || !/^[0-9a-f]{64}$/.test(trust.mainSha256)) {
    throw new SourceCacheError("Public snapshot trust violates the pinned manifest contract");
  }
}

function verifiedBytes(
  expected: PublicSnapshotFile,
  bytes: Buffer,
  mainSha256: string,
): VerifiedFile {
  if (bytes.length !== expected.size || bytes.length > MAX_FILE_BYTES) {
    throw new SourceCacheError("Public snapshot file size differs from the pinned size");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const oid = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  assertFileDigests(expected, sha256, oid, mainSha256);
  return { ...expected, sha256 };
}

async function importPublicMain(
  sourcePath: string,
  staging: string,
  expected: PublicSnapshotFile,
  mainSha256: string,
): Promise<VerifiedFile> {
  const absoluteSource = resolve(sourcePath);
  const bytes = await readBoundedRegularFile(absoluteSource, {
    label: "Optional public JSONL source",
    maximumBytes: MAX_FILE_BYTES,
    expectedSize: expected.size,
    requireSingleLink: false,
  });
  const verified = verifiedBytes(expected, bytes, mainSha256);
  const destination = localSnapshotPath(staging, expected.path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
  return verified;
}

function canonicalInternalManifest(files: readonly VerifiedFile[], mainSha256: string): string {
  const sorted = [...files]
    .sort((left, right) => compareText(left.path, right.path))
    .map((file) => ({
      type: file.type,
      path: file.path,
      oid: file.oid,
      size: file.size,
      sha256: file.sha256,
    }));
  return `${JSON.stringify({
    repository: HF_REPOSITORY,
    commit: HF_COMMIT,
    mainSha256,
    files: sorted,
  })}\n`;
}

function validateSelectedDatabases(mainText: string, trust: SnapshotTrust): void {
  const rows = parsePublicJsonl(mainText);
  const selected = [...new Set(rows.map((row) => row.selected_database))]
    .sort(compareText);
  const expected = trustedDatabaseNames(trust);
  if (
    selected.length !== TRUSTED_DATABASE_COUNT ||
    selected.some((database, index) => database !== expected[index])
  ) {
    throw new SourceCacheError("Public JSONL selected databases do not match the 18 pinned metadata triplets");
  }
}

interface LocalTree {
  readonly files: string[];
  readonly directories: string[];
}

// Strict offline verification binds the local cache to the tracked trust root.
async function walkLocalSnapshot(root: string, relative = "", tree?: { files: string[]; directories: string[] }): Promise<LocalTree> {
  const result = tree ?? { files: [], directories: [] };
  const absolute = relative === "" ? root : localSnapshotPath(root, relative);
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (!isSafeRelativePath(child)) {
      throw new SourceCacheError("Local public snapshot contains an unsafe path");
    }
    if (entry.isSymbolicLink()) {
      throw new SourceCacheError("Local public snapshot contains a symlink");
    }
    if (entry.isDirectory()) {
      result.directories.push(child);
      await walkLocalSnapshot(root, child, result);
    } else if (entry.isFile()) {
      result.files.push(child);
    } else {
      throw new SourceCacheError("Local public snapshot contains a non-file entry");
    }
  }
  result.files.sort(compareText);
  result.directories.sort(compareText);
  return result;
}

function expectedLocalDirectories(trust: SnapshotTrust): string[] {
  const directories = new Set<string>();
  for (const file of trust.files) {
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return [...directories].sort(compareText);
}

async function verifyLocalFile(
  root: string,
  expected: PublicSnapshotFile,
  mainSha256: string,
): Promise<VerifiedFile> {
  const path = localSnapshotPath(root, expected.path);
  const bytes = await readBoundedRegularFile(path, {
    label: "Local public snapshot file",
    maximumBytes: MAX_FILE_BYTES,
    expectedSize: expected.size,
    requireSingleLink: true,
  });
  return verifiedBytes(expected, bytes, mainSha256);
}

async function verifySnapshotOfflineWithTrust(
  cacheDir: string,
  trust: SnapshotTrust,
): Promise<PublicSnapshotVerification> {
  validateSnapshotTrust(trust);
  const root = resolve(cacheDir);
  let rootDetails;
  try {
    rootDetails = await lstat(root);
  } catch {
    throw new SourceCacheError("Local public snapshot cache does not exist");
  }
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new SourceCacheError("Local public snapshot cache must be a real directory");
  }

  const actualTree = await walkLocalSnapshot(root);
  const expectedFiles = [...trust.files.map((file) => file.path), "_warble-source.json"]
    .sort(compareText);
  if (
    actualTree.files.length !== expectedFiles.length ||
    actualTree.files.some((path, index) => path !== expectedFiles[index])
  ) {
    throw new SourceCacheError("Local public snapshot file set is incomplete or contains extras");
  }
  const expectedDirectories = expectedLocalDirectories(trust);
  if (
    actualTree.directories.length !== expectedDirectories.length ||
    actualTree.directories.some((path, index) => path !== expectedDirectories[index])
  ) {
    throw new SourceCacheError("Local public snapshot directory set is incomplete or contains extras");
  }

  const manifestPath = localSnapshotPath(root, "_warble-source.json");
  const manifestBytes = await readBoundedRegularFile(manifestPath, {
    label: "Local public snapshot manifest",
    maximumBytes: 256 * 1024,
    requireSingleLink: true,
  });
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new SourceCacheError("Local public snapshot manifest is not valid JSON");
  }
  const parsedManifest = internalManifestSchema.safeParse(manifestValue);
  if (!parsedManifest.success || parsedManifest.data.mainSha256 !== trust.mainSha256) {
    throw new SourceCacheError("Local public snapshot manifest violates the pinned schema");
  }

  const verified: VerifiedFile[] = [];
  for (const expected of trust.files) {
    verified.push(await verifyLocalFile(root, expected, trust.mainSha256));
  }
  const canonical = canonicalInternalManifest(verified, trust.mainSha256);
  if (!manifestBytes.equals(Buffer.from(canonical))) {
    throw new SourceCacheError("Local public snapshot manifest is not the exact canonical manifest");
  }
  return {
    path: root,
    repository: HF_REPOSITORY,
    commit: HF_COMMIT,
    fileCount: TRUSTED_FILE_COUNT,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
  };
}

async function acquireSnapshotWithTrust(
  options: EnsurePublicSnapshotOptions,
  trust: SnapshotTrust,
): Promise<PublicSnapshotVerification> {
  validateSnapshotTrust(trust);
  const fetcher = options.fetch ?? globalThis.fetch;
  await enumerateOfficialTree(fetcher, trust);
  const expectedTotal = trust.files.reduce((total, file) => total + file.size, 0);
  if (!Number.isSafeInteger(expectedTotal) || expectedTotal > MAX_TOTAL_BYTES) {
    throw new SourceCacheError("Pinned Hugging Face snapshot exceeds the total byte limit");
  }
  const target = resolve(options.cacheDir);
  if (await pathExists(target)) {
    return verifySnapshotOfflineWithTrust(target, trust);
  }

  await mkdir(dirname(target), { recursive: true });
  const staging = stagingPathFor(target);
  try {
    await mkdir(staging);
    const main = trust.files.find((file) => file.path === MAIN_PUBLIC_PATH)!;
    const ordered = [main, ...trust.files.filter((file) => file.path !== MAIN_PUBLIC_PATH)];
    const verified: VerifiedFile[] = [];
    for (const expected of ordered) {
      if (expected.path === MAIN_PUBLIC_PATH && options.publicDataPath !== undefined) {
        verified.push(await importPublicMain(options.publicDataPath, staging, expected, trust.mainSha256));
      } else {
        verified.push(await downloadOfficialFile(fetcher, staging, expected, trust.mainSha256));
      }
    }

    const mainText = await readFile(localSnapshotPath(staging, MAIN_PUBLIC_PATH), "utf8");
    validateSelectedDatabases(mainText, trust);
    const manifest = canonicalInternalManifest(verified, trust.mainSha256);
    await writeFile(localSnapshotPath(staging, "_warble-source.json"), manifest, { flag: "wx", mode: 0o644 });
    const stagedVerification = await verifySnapshotOfflineWithTrust(staging, trust);
    if (await pathExists(target)) {
      throw new SourceCacheError("Public snapshot cache appeared while acquisition was in progress");
    }
    await rename(staging, target);
    return { ...stagedVerification, path: target };
  } catch (error) {
    await removeStaging(staging, target);
    if (error instanceof SourceCacheError) throw error;
    throw new SourceCacheError("Failed to acquire the official public snapshot");
  }
}

export async function ensurePublicSnapshot(
  options: EnsurePublicSnapshotOptions,
): Promise<PublicSnapshotVerification> {
  return acquireSnapshotWithTrust(options, OFFICIAL_SNAPSHOT_TRUST);
}

export async function verifyPublicSnapshotOffline(
  cacheDir: string,
): Promise<PublicSnapshotVerification> {
  return verifySnapshotOfflineWithTrust(cacheDir, OFFICIAL_SNAPSHOT_TRUST);
}
