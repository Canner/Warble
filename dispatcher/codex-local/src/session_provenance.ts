import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { CodexDispatchError } from "./error.js";

/** Host-only metadata, never a transcript or a model-visible source of authority. */
export class SessionProvenance {
  private readonly binding: string;
  constructor(private readonly home: string, binding: string) {
    this.binding = createHash("sha256").update(binding).digest("hex");
  }

  private async path(threadId: string): Promise<string> {
    const dir = join(this.home, "warble-session-provenance");
    await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new CodexDispatchError("unsafe session provenance directory");
    }
    return join(dir, createHash("sha256").update(threadId).digest("hex") + ".json");
  }

  async create(threadId: string): Promise<void> {
    const file = await open(await this.path(threadId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify({ binding: this.binding, turns: [] })); }
    finally { await file.close(); }
  }

  async turns(threadId: string): Promise<string[]> {
    try {
      const file = await open(await this.path(threadId), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("unsafe metadata");
        const record = JSON.parse(await file.readFile("utf8")) as { binding?: unknown; turns?: unknown };
        if (record.binding !== this.binding || !Array.isArray(record.turns) || !record.turns.every((id) => typeof id === "string")) throw new Error("untrusted metadata");
        return record.turns as string[];
      } finally { await file.close(); }
    } catch {
      throw new CodexDispatchError("session provenance is unavailable or belongs to another step binding");
    }
  }

  async record(threadId: string, turnId: string): Promise<void> {
    const turns = await this.turns(threadId);
    const file = await open(await this.path(threadId), constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      await file.truncate(0);
      await file.writeFile(JSON.stringify({ binding: this.binding, turns: [...new Set([...turns, turnId])] }));
    } finally { await file.close(); }
  }
}
