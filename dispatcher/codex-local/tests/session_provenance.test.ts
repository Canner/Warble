import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SessionProvenance } from "../src/session_provenance.js";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "warble-provenance-test-"));
  scratch.push(home);
  const dir = join(home, "warble-session-provenance");
  return {
    home, dir, ledger: new SessionProvenance(home, "binding"),
    file: (id: string) => join(dir, createHash("sha256").update(id).digest("hex") + ".json"),
  };
}

test("provenance round-trips only recorded turn IDs and refuses duplicate thread creation", async () => {
  const { home, ledger } = fixture();
  await ledger.create("thread");
  await ledger.record("thread", "turn");
  await ledger.record("thread", "turn");
  assert.deepEqual(await new SessionProvenance(home, "binding").turns("thread"), ["turn"]);
  await assert.rejects(ledger.create("thread"), /EEXIST/);
});

for (const unsafe of ["permissions", "symlink"] as const) {
  test(`provenance rejects directory ${unsafe}`, async () => {
    const { home, dir, ledger } = fixture();
    if (unsafe === "permissions") { mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o755); }
    else {
      const target = join(home, "target");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, dir);
    }
    await assert.rejects(ledger.create("thread"), /unsafe session provenance directory/);
  });
}

for (const unsafe of ["permissions", "symlink"] as const) {
  test(`provenance rejects metadata file ${unsafe}`, async () => {
    const { ledger, file } = fixture();
    await ledger.create("thread");
    if (unsafe === "permissions") chmodSync(file("thread"), 0o644);
    else symlinkSync(file("thread"), file("alias"));
    await assert.rejects(ledger.turns(unsafe === "permissions" ? "thread" : "alias"), /provenance is unavailable/);
  });
}

test("provenance rejects missing, malformed, and changed-binding metadata", async () => {
  const { home, ledger, file } = fixture();
  await assert.rejects(ledger.turns("missing"), /provenance is unavailable/);
  await ledger.create("thread");
  await assert.rejects(new SessionProvenance(home, "other").turns("thread"), /another step binding/);
  writeFileSync(file("thread"), "not-json");
  await assert.rejects(ledger.turns("thread"), /provenance is unavailable/);
});
