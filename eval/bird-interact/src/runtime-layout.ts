import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import { z } from "zod";

/**
 * Names and shapes of the prepared `data/` tree. This module deliberately holds no CLI entry point:
 * `prepare-cli` and `smoke-cli` are both bins, and a bin that imports another bin's module would run
 * that bin's `main()` too once the bundler inlines it.
 */

export const SMOKE_DATABASE = "alien";
export const SMOKE_TASK_IDS = ["alien_1", "alien_2", "alien_3", "alien_4", "alien_5"] as const;
export const GT_FILENAME = "bird_interact_gt_kg_testcases_1008.jsonl";
export const COMBINED_FILENAME = "bird_interact_data_with_gt.jsonl";
export const SMOKE_FILENAME = "smoke-alien-5.jsonl";
export const RUNTIME_DIRECTORY = "runtime";
export const PUBLIC_CACHE_DIRECTORY = "bird-interact-lite";
export const IDENTITY_PROJECTS = "identity-projects";
export const ADK_DIRECTORY = "BIRD-Interact-ADK";
/** The Warble profile this adapter serves, tracked inside the package beside `src/`. */
export const PROFILE_DIRECTORY = "agent";
export const TEMPLATE_SUFFIX = "_template";

/**
 * The official DB environment clones each task database with
 * `createdb <task_db> --template <base_db>_template`, so the physical schema lives in the template,
 * never in a database named after `selected_database`.
 */
export function templateDatabase(base: string): string {
  return `${base}${TEMPLATE_SUFFIX}`;
}
export const PUBLIC_MAIN_JSONL = "bird_interact_data.jsonl";

export interface PrepareManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly official: { readonly repository: string; readonly commit: string };
  readonly publicSnapshot: {
    readonly repository: string;
    readonly commit: string;
    readonly fileCount: number;
    readonly manifestSha256: string;
  };
  readonly groundTruth: { readonly file: string; readonly sha256: string };
  readonly outputs: {
    readonly combined: { readonly file: string; readonly rows: number; readonly sha256: string };
    readonly smoke: { readonly file: string; readonly rows: number; readonly sha256: string };
    readonly mdl: { readonly file: string; readonly sha256: string };
  };
  readonly database: {
    readonly name: string;
    readonly template: string;
    readonly container: string;
    readonly hostPort: number;
    readonly imageReference: string;
    readonly imageId: string;
    readonly repoDigests: readonly string[];
  };
  readonly wren: { readonly version: string };
  readonly taskIds: readonly string[];
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const prepareManifestSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string().min(1),
    official: z.object({ repository: z.string().min(1), commit: z.string().min(1) }).strict(),
    publicSnapshot: z
      .object({
        repository: z.string().min(1),
        commit: z.string().min(1),
        fileCount: z.number().int().positive(),
        manifestSha256: sha256Schema,
      })
      .strict(),
    groundTruth: z.object({ file: z.string().min(1), sha256: sha256Schema }).strict(),
    outputs: z
      .object({
        combined: z.object({ file: z.string().min(1), rows: z.number().int().positive(), sha256: sha256Schema }).strict(),
        smoke: z.object({ file: z.string().min(1), rows: z.number().int().positive(), sha256: sha256Schema }).strict(),
        mdl: z.object({ file: z.string().min(1), sha256: sha256Schema }).strict(),
      })
      .strict(),
    database: z
      .object({
        name: z.string().min(1),
        template: z.string().min(1),
        container: z.string().min(1),
        hostPort: z.number().int().positive(),
        imageReference: z.string().min(1),
        imageId: z.string().min(1),
        repoDigests: z.array(z.string()),
      })
      .strict(),
    wren: z.object({ version: z.string().min(1) }).strict(),
    taskIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

/** Reads a previously promoted manifest, or null when none is present or parseable. */
export async function readPrepareManifest(runtimeDir: string): Promise<PrepareManifest | null> {
  let text: string;
  try {
    text = await readFile(join(runtimeDir, "manifest.json"), "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = prepareManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/* -------------------------------------------------------------------------- */
/* The run-versus-runtime cross-check                                         */
/* -------------------------------------------------------------------------- */

/** One manifest field on which a run and the current `data/runtime/` tree disagree. */
export interface ManifestDifference {
  readonly field: string;
  /** The value the run recorded for itself when it ran. */
  readonly run: string;
  /** The value `data/runtime/manifest.json` carries now. */
  readonly runtime: string;
}

/**
 * The manifest fields that decide whether a run and the tree on disk are the same measurement.
 *
 * Both report commands read a run's own `manifest.json` for provenance and then read GOLD SQL,
 * ambiguity snippets, difficulty labels and the database connection out of the CURRENT
 * `data/runtime/` tree. If preparation has been re-run for a different subset since, those two
 * sources describe different things and the artifact silently attributes one to the other — the
 * same misattribution class as reading a live `.env` for a finished run's simulator model.
 *
 * So the comparison is deliberately over **dataset identity and database identity**, and nothing
 * else:
 *
 * - `official.commit`, `publicSnapshot.commit` and `publicSnapshot.manifestSha256` — the upstream
 *   trees the prepared dataset was built and merged from, and the two commits a report PRINTS as
 *   the provenance of gold it reads out of the runtime tree;
 * - `groundTruth.sha256` — the gated ground-truth file gold SQL ultimately comes from;
 * - `outputs.combined.*` — `bird_interact_data_with_gt.jsonl` itself: the exact file both commands
 *   open for gold, snippets and difficulty;
 * - `outputs.smoke.*` — the promoted subset the run was drawn from;
 * - `outputs.mdl.sha256` — the identity MDL the run's agent planned through; a different MDL is a
 *   different semantic layer over the same tables;
 * - `database.name`, `.template`, `.container`, `.hostPort`, `.imageId` — where an autopsy
 *   connects and which image serves it. The autopsy takes all three from the runtime manifest, so
 *   a disagreement here means replaying a run against a database it never used;
 * - `taskIds` — the task set the prepared tree is scoped to. A tree re-prepared for a different
 *   set has had its runtime files rewritten, which is exactly the state `data/runs/alien-3`
 *   against a five-task runtime is in.
 *
 * Four fields are deliberately NOT compared, because a difference in them misattributes nothing:
 *
 * - `createdAt` — a wall clock stamp. Re-preparing byte-identical inputs changes it and changes
 *   nothing about the data, so comparing it would refuse every legitimate re-preparation;
 * - `version` — a literal the schema already pins;
 * - `database.imageReference` — a mutable tag (`:latest`); `imageId` is the content-addressed
 *   identity that actually pins the image, and it IS compared;
 * - `database.repoDigests` — registry bookkeeping, empty until an image is pulled or pushed and
 *   able to differ for one and the same `imageId`;
 * - `official.repository` / `publicSnapshot.repository` — where a commit was fetched from. The
 *   commit and content hashes beside them pin what was fetched.
 *
 * `wren.version` is likewise left out: it is provenance a run prints from its OWN manifest, and it
 * does not change the dataset. The MDL hash covers what Wren actually produced.
 */
const COMPARED_MANIFEST_FIELDS: readonly (readonly [string, (manifest: PrepareManifest) => string])[] = [
  ["official.commit", (m) => m.official.commit],
  ["publicSnapshot.commit", (m) => m.publicSnapshot.commit],
  ["publicSnapshot.manifestSha256", (m) => m.publicSnapshot.manifestSha256],
  ["groundTruth.sha256", (m) => m.groundTruth.sha256],
  ["outputs.combined.file", (m) => m.outputs.combined.file],
  ["outputs.combined.sha256", (m) => m.outputs.combined.sha256],
  ["outputs.smoke.file", (m) => m.outputs.smoke.file],
  ["outputs.smoke.sha256", (m) => m.outputs.smoke.sha256],
  ["outputs.mdl.sha256", (m) => m.outputs.mdl.sha256],
  ["database.name", (m) => m.database.name],
  ["database.template", (m) => m.database.template],
  ["database.container", (m) => m.database.container],
  ["database.hostPort", (m) => String(m.database.hostPort)],
  ["database.imageId", (m) => m.database.imageId],
  ["taskIds", (m) => m.taskIds.join(", ")],
];

/** The field names this cross-check covers, in the order it reports them. */
export const COMPARED_MANIFEST_FIELD_NAMES: readonly string[] = COMPARED_MANIFEST_FIELDS.map(
  ([field]) => field,
);

/** Every dataset- or database-identity field on which the two manifests disagree. */
export function compareRunManifest(
  run: PrepareManifest,
  runtime: PrepareManifest,
): ManifestDifference[] {
  const differences: ManifestDifference[] = [];
  for (const [field, valueOf] of COMPARED_MANIFEST_FIELDS) {
    const recorded = valueOf(run);
    const current = valueOf(runtime);
    if (recorded !== current) differences.push({ field, run: recorded, runtime: current });
  }
  return differences;
}

/**
 * The refusal a caller raises when `compareRunManifest` found anything.
 *
 * It names every field that differs with both values, because "the manifests disagree" sends a
 * reader to diff two JSON files by hand; `consequence` is the caller's own sentence about what it
 * would otherwise have written, since the report and the autopsy misattribute different things.
 */
export function describeManifestMismatch(
  run: string,
  differences: readonly ManifestDifference[],
  consequence: string,
): string {
  const rows = differences
    .map((d) => `  ${d.field}: the run recorded ${d.run}; data/runtime/manifest.json now has ${d.runtime}`)
    .join("\n");
  return (
    `run ${run} did not run against the data/runtime tree that is on disk now:\n${rows}\n` +
    `${consequence} Re-prepare the tree the run used, or report a run that matches this one; ` +
    `a report that describes a dataset or a database the run never faced is worse than no report.`
  );
}

/* -------------------------------------------------------------------------- */
/* Where a gold-bearing artifact may be written                               */
/* -------------------------------------------------------------------------- */

/**
 * `realpath` of the deepest existing ancestor, with the not-yet-created tail appended.
 *
 * An output path usually does not exist yet, so `realpath` on it fails outright; resolving only
 * the part that DOES exist is what makes the containment check below see through symlinks. A
 * `data/report.html` that is a symlink to `/tmp/x.html` resolves to `/tmp/x.html` and is refused,
 * and `data/runs/../../../report.html` collapses before it is ever compared.
 */
async function realPathOfNearestExisting(path: string): Promise<string> {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    const real = await realpath(current).catch(() => null);
    if (real !== null) return join(real, ...[...tail].reverse());
    const parent = dirname(current);
    // The filesystem root itself is missing only on a path that cannot exist at all.
    if (parent === current) return resolve(path);
    tail.push(basename(current));
    current = parent;
  }
}

/** A requested output path, resolved, and why writing there is refused. */
export interface GatedOutputPath {
  /** The path that would actually be written, with every symlink and `..` resolved. */
  readonly resolved: string;
  /** `null` when the path is inside the ignored data tree. */
  readonly refusal: string | null;
}

export interface GatedOutputRequest {
  /** The package's `data/` directory: the whole of it is gitignored. */
  readonly dataRoot: string;
  /** The path the flag asked for, relative to the process's working directory. */
  readonly path: string;
  /** The flag that named it, for the refusal message. */
  readonly flag: string;
  /** What would be written there, for the refusal message. */
  readonly artifact: string;
}

/**
 * Refuse to write gated ground truth outside the one tree Git ignores.
 *
 * `report.json`, `report.html` and `autopsy.html` all embed the benchmark's own `sol_sql` — gated
 * material this package may keep only under `data/`, whose `.gitignore` ignores everything in it.
 * `--out` and `--json` resolved an arbitrary path with no check at all, and the justfile recipes
 * `cd eval/bird-interact` first: `just report-bird-eval alien-5 --out report.html` wrote gold SQL
 * into a tracked directory, one `git add -A` from being committed.
 *
 * Containment is checked on the resolved real path and by path SEGMENT, so `..` traversal, a
 * symlink pointing out of the tree, and a sibling directory whose name merely starts with the
 * data root (`data-public/`) are all outside. The data root itself is outside too: it is a
 * directory, and a write there could only fail.
 */
export async function checkGatedOutputPath(request: GatedOutputRequest): Promise<GatedOutputPath> {
  const root = await realPathOfNearestExisting(request.dataRoot);
  const resolved = await realPathOfNearestExisting(request.path);
  if (resolved.startsWith(`${root}${sep}`)) return { resolved, refusal: null };
  return {
    resolved,
    refusal:
      `${request.flag} would write ${request.artifact} to ${resolved}, which is outside ${root}. ` +
      `That file carries the benchmark's ground-truth SQL, which is gated material: everything ` +
      `under ${root} is gitignored, and anywhere else is one \`git add -A\` from committing it. ` +
      `Name a path inside ${root}.`,
  };
}

/**
 * What a finished run records about the model that drove the official user simulator.
 *
 * The simulator's behaviour is part of the measurement, so a run has to be able to say what it ran
 * on. It could not: the report used to read `USER_SIM_MODEL` out of the CURRENT `data/private/.env`
 * and print it as the finished run's provenance, so editing that file silently re-attributed every
 * past run. A run records this for itself, once, at the moment the model is resolved.
 *
 * The model NAME is the whole record. That same `.env` holds the key the model authenticates with,
 * and a run directory is an artifact people copy, diff and attach to a report, so no other variable
 * from it is ever written into one.
 *
 * An oracle-only run never calls the simulator and writes no file at all — absent, never an empty
 * string. Absent reads as *unrecorded*, which is also how every run finished before this file
 * existed reads; a malformed record reads the same way, since neither can name a model and neither
 * may be answered with a guess.
 */
export const USER_SIMULATOR_FILENAME = "user-simulator.json";

export interface UserSimulatorRecord {
  readonly version: 1;
  readonly model: string;
}

export const userSimulatorRecordSchema = z
  .object({ version: z.literal(1), model: z.string().min(1) })
  .strict();

/** Reads a run's own user-simulator record, or null when that run recorded none. */
export async function readUserSimulatorRecord(runDir: string): Promise<UserSimulatorRecord | null> {
  let text: string;
  try {
    text = await readFile(join(runDir, USER_SIMULATOR_FILENAME), "utf8");
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = userSimulatorRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
