import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PLANNING_TIMEOUT_MS = 30_000;

export interface WrenPlanner {
  plan(dbName: string, sql: string): Promise<string>;
  projectPath(dbName: string): string;
}

export interface ProcessWrenPlannerConfig {
  projectRoot: string;
  wrenBin?: string;
  env?: NodeJS.ProcessEnv;
  planningTimeoutMs?: number;
}

export class WrenPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WrenPlanningError";
  }
}

export function isQueryLikeStatement(sql: string): boolean {
  const cleaned = sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .toUpperCase();
  return ["SELECT", "WITH", "EXPLAIN"].some((prefix) =>
    cleaned.startsWith(prefix),
  );
}

export class ProcessWrenPlanner implements WrenPlanner {
  private readonly projectRoot: string;
  private readonly wrenBin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly planningTimeoutMs: number;

  constructor(config: ProcessWrenPlannerConfig) {
    this.projectRoot = resolve(config.projectRoot);
    this.wrenBin = config.wrenBin ?? "wren";
    this.env = config.env ?? process.env;
    this.planningTimeoutMs =
      config.planningTimeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS;
    if (
      !Number.isInteger(this.planningTimeoutMs) ||
      this.planningTimeoutMs <= 0
    ) {
      throw new WrenPlanningError("Wren planning timeout must be a positive integer");
    }
  }

  projectPath(dbName: string): string {
    const candidate = resolve(this.projectRoot, dbName);
    const rootPrefix = this.projectRoot.endsWith(sep)
      ? this.projectRoot
      : `${this.projectRoot}${sep}`;
    if (candidate === this.projectRoot || !candidate.startsWith(rootPrefix)) {
      throw new WrenPlanningError(
        `Wren project for database '${dbName}' resolves outside configured root`,
      );
    }
    return candidate;
  }

  async plan(dbName: string, sql: string): Promise<string> {
    const project = this.projectPath(dbName);
    const mdl = resolve(project, "target", "mdl.json");
    try {
      const { stdout } = await execFileAsync(
        this.wrenBin,
        [
          "dry-plan",
          "--sql",
          sql,
          "--datasource",
          "postgres",
          "--mdl",
          mdl,
        ],
        {
          cwd: project,
          env: this.env,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
          timeout: this.planningTimeoutMs,
          killSignal: "SIGKILL",
        },
      );
      const planned = stdout.trim();
      if (!planned) throw new WrenPlanningError("Wren dry-plan returned empty SQL");
      return planned;
    } catch (error) {
      if (error instanceof WrenPlanningError) throw error;
      const timedOut =
        typeof error === "object" &&
        error !== null &&
        "killed" in error &&
        error.killed === true;
      if (timedOut) {
        throw new WrenPlanningError(
          `Wren dry-plan timed out after ${this.planningTimeoutMs}ms`,
        );
      }
      const stderr =
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? error.stderr.trim()
          : "";
      throw new WrenPlanningError(
        `Wren dry-plan failed${stderr ? `: ${stderr}` : ""}`,
      );
    }
  }
}
