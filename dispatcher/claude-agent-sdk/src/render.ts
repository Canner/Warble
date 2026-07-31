/**
 * Render step — reuse the Warble reference renderer (`warble render`) rather than reimplementing it
 * in TS (ir-schema §v0.3). The agent (programmatic flavor) emits a
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
    throw new DispatchError(missingWarbleBinaryMessage(opts.warbleBin, proc.error));
  }
  if (proc.status !== 0) {
    throw new DispatchError(
      `warble render exited ${proc.status}: ${proc.stderr?.trim() || proc.stdout?.trim() || "no output"}`,
    );
  }
  return { outPath, log: (proc.stderr ?? "").trim() };
}

/**
 * One actionable message for a failed `spawnSync` on the `warble` binary. ENOENT (the binary isn't
 * on PATH, or `warbleBin`/`--warble-bin` points at nothing) is by far the common case for someone
 * who installed this npm package on its own — `@warble/claude-agent-sdk` never bundles or fetches
 * the `warble` binary itself, so it names the one channel that's genuinely public and works
 * unauthenticated: `cargo install warble-cli` (crates.io). Any other spawn error (e.g. a permission
 * problem on an existing path) gets the underlying message plus the override, without the
 * misleading "go install it" hint.
 *
 * Names `warbleBin` (the actual knob) before `--warble-bin` (its CLI spelling): this message fires
 * from three call sites with different surfaces — the `warble-agent-sdk` CLI (where `--warble-bin`
 * is real), a library consumer calling `renderEnvelope` directly (no CLI flag exists — only the
 * `warbleBin` option), and an emitted standalone agent module (same: only its `RunOptions.warbleBin`
 * option exists). Leading with a flag a library caller has no way to pass would be actionable in
 * only one of the three contexts.
 */
function missingWarbleBinaryMessage(warbleBin: string, error: NodeJS.ErrnoException): string {
  const base = `failed to run '${warbleBin} render': ${error.message}`;
  if (error.code === "ENOENT") {
    return (
      `${base}\n` +
      `The 'warble' binary was not found. Install it with 'cargo install warble-cli' ` +
      `(requires a Rust toolchain; installs from crates.io), or set the 'warbleBin' option ` +
      `(CLI: --warble-bin <path>) to point at an existing 'warble' binary.`
    );
  }
  return `${base} (set the 'warbleBin' option, or pass --warble-bin <path> on the CLI, to point at a different binary)`;
}
