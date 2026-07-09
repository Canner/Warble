/**
 * Render step — reuse the Warble reference renderer (`warble render`) rather than reimplementing it
 * in TS (plan decision #5, ir-schema §v0.3). The agent (programmatic flavor) emits a
 * `{ blocks, summary }` envelope as its final message; we hand that text to `warble render`, which
 * deterministically produces a self-contained `dashboard.html`. Same envelope ⇒ identical bytes as
 * the file target — that is the "one renderer, many back-ends" contract being exercised across
 * languages.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DispatchError } from "./error.js";

export interface RenderResult {
  outPath: string;
  /** stderr from `warble render` (it logs "wrote … (N block(s))"). */
  log: string;
}

/**
 * Write the captured agent output to a temp file and shell out to `warble render`. `warble render`
 * tolerates the model fencing/prose-wrapping the envelope and unwraps a `--output-format json`
 * result object (see the Rust `parseEnvelope`), so we pass the raw final text through unchanged.
 */
export function renderEnvelope(
  finalText: string,
  outPath: string,
  opts: { warbleBin: string; title?: string },
): RenderResult {
  const dir = mkdtempSync(join(tmpdir(), "warble-sdk-"));
  const envelopePath = join(dir, "envelope.txt");
  writeFileSync(envelopePath, finalText, "utf8");

  const args = ["render", envelopePath, "--out", outPath];
  if (opts.title) args.push("--title", opts.title);

  const proc = spawnSync(opts.warbleBin, args, { encoding: "utf8" });
  if (proc.error) {
    throw new DispatchError(
      `failed to run '${opts.warbleBin} render': ${proc.error.message} ` +
        `(is the warble binary on PATH? pass --warble-bin to override)`,
    );
  }
  if (proc.status !== 0) {
    throw new DispatchError(
      `warble render exited ${proc.status}: ${proc.stderr?.trim() || proc.stdout?.trim() || "no output"}`,
    );
  }
  return { outPath, log: (proc.stderr ?? "").trim() };
}
