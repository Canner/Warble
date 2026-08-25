import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
