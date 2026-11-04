import { Input, Text, TuiMainScreen, ProcessTerminal, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui";
import { HybridPlanner } from "./planner.js";
import type { Choice } from "./planner.js";
import { parseMetadataSelection } from "./selection.js";
import { EVIDENCE_NOTICE } from "./evidence.js";

export const NOTICE = "Already-sent data cannot be recalled. Settings changes start an empty epoch.";
const clean = (s: string) => stripTerminalSequences(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
function ownedTerminal(): Terminal {
  // pi-tui supports an ambient write-log variable. The governed UI never enables it.
  const previous = process.env.PI_TUI_WRITE_LOG;
  delete process.env.PI_TUI_WRITE_LOG;
  try { return new ProcessTerminal(); }
  finally { if (previous !== undefined) process.env.PI_TUI_WRITE_LOG = previous; }
}
export async function runTui(planner: HybridPlanner, terminal: Terminal = ownedTerminal()): Promise<void> {
  if (!planner.status) await planner.reset();
  const tui = new TuiMainScreen(terminal), heading = new Text(), output = new Text(), input = new Input({ prompt: "> " });
  let lines: string[] = [], ended = false, operation = 0;
  const refresh = () => {
    const s = planner.status;
    heading.setText(clean(`Warble pi:hybrid — limited pi TUI\n${s ? `epoch=${s.epoch} project=${s.project} model=${s.api}/${s.modelId} selection=${s.disclosure === undefined ? s.policy : "custom (base=" + s.policy + ")"}\npolicy=${s.policyDigest}\nrequested=${s.requestedMetadata.map(m => m.kind + "=" + (m.documents === "*" ? "*" : m.documents.join(","))).join(" ") || "none"}\nmetadata=${s.metadata.join(", ") || "none (blind planner)"}\nunavailable=${s.unavailableMetadata.join(", ") || "none"}\ntools=${s.tools.join(", ") || "none"}` : "No active epoch; use /reset"}\n${NOTICE}\n/help for commands`));
    output.setText(lines.join("\n")); tui.requestRender();
  };
  const append = (text: string) => { lines.push(clean(text)); lines = lines.slice(-100); refresh(); };
  tui.addChild(heading); tui.addChild(output); tui.addChild(input); tui.setFocus(input);
  await new Promise<void>(resolve => {
    const quit = () => {
      if (ended) return; ended = true; operation++; planner.close();
      process.removeListener("SIGTERM", quit); process.removeListener("SIGINT", quit);
      tui.stop(); resolve();
    };
    process.on("SIGTERM", quit); process.on("SIGINT", quit);
    tui.addInputListener(data => { if (data === "\x03" || data === "\x04") { quit(); return { consume: true }; } return undefined; });
    input.onSubmit = text => {
      input.setValue(""); const trimmed = text.trim();
      if (!trimmed || ended) return;
      if (trimmed === "/quit") { quit(); return; }
      if (trimmed === "/help") {
        append(`/reset /policy <name> /metadata [none|kind=doc,doc kind=*] /evidence [number] /model <name> /project <name> /quit\n${JSON.stringify(planner.choices)}\n/metadata lists available document IDs. A selection replaces the entire metadata set; /policy restores its preset.\n/evidence inspects local approved tool data without a model call. ${EVIDENCE_NOTICE}\nNo shell, attachments, resume, import, export, sharing or compaction.`); return;
      }
      if (/^\/evidence(?:\s|$)/.test(trimmed)) {
        const match = /^\/evidence(?:\s+([1-9]\d{0,8}))?$/.exec(trimmed);
        if (!match) { append("Usage: /evidence [number]"); return; }
        const records = planner.evidence(match[1] ? Number(match[1]) : undefined);
        if (!records.length) { append("Evidence unavailable in this epoch (missing, cleared or expired)."); return; }
        const r = records[0]!;
        const detail = `Evidence [${r.reference}]\nTool: ${r.tool}\nRequest (model intent): ${r.request}\nCompleted (UTC): ${r.completedAt}\nProject: ${r.project}; epoch: ${r.epoch}\nPolicy: ${r.policyDigest}\nMetadata: ${r.metadata.join(", ") || "none"}\nApproved result: ${JSON.stringify(r.result, null, 2).replace(/\n\s*/g, " ")}`;
        append((match[1] ? detail : records.map(r => `[${r.reference}] ${r.completedAt} ${r.tool}: ${r.request}`).join("\n"))
          + "\n" + EVIDENCE_NOTICE); return;
      }
      if (trimmed === "/metadata") {
        append("Available within deployment policy: " + (planner.status?.availableMetadata.join(", ") || "none")
          + "\nUse /metadata none or /metadata kind=doc,doc kind=*; changes start an empty epoch."); return;
      }
      if (trimmed.startsWith("/") || trimmed.startsWith("!")) {
        const parts = trimmed.split(/\s+/), verb = parts[0];
        if (!(verb === "/reset" && parts.length === 1) && !(verb === "/metadata" && parts.length >= 2)
          && !(["/policy", "/model", "/project"].includes(verb!) && parts.length === 2)) {
          append("Unsupported command."); return;
        }
        const status = planner.status;
        let choice: Choice | undefined = status ? { policy: status.policy, model: status.model, project: status.project,
          ...(status.disclosure !== undefined ? { disclosure: status.disclosure } : {}) } : undefined;
        if (verb !== "/reset") {
          if (!choice) { append("Use /reset first."); return; }
          if (verb === "/metadata") {
            try { choice = { ...choice, disclosure: parseMetadataSelection(parts.slice(1).join(" ")) }; }
            catch { append("Invalid metadata selection. Current epoch unchanged."); return; }
          } else {
            choice = { ...choice, [verb!.slice(1)]: parts[1] };
            if (verb === "/policy") delete choice.disclosure;
          }
        }
        const token = ++operation;
        void planner.reset(choice).then(() => {
          if (!ended && token === operation) { lines = []; append("New empty epoch. " + NOTICE); }
        }).catch(() => { if (!ended && token === operation) append("Selection unavailable."); });
        return;
      }
      const token = operation;
      append("You: " + text);
      void planner.prompt(text).then(answer => { if (!ended && token === operation) append("Assistant: " + planner.formatAnswer(answer)); })
        .catch(() => { if (!ended && token === operation) append("Request unavailable or busy."); });
    };
    refresh(); tui.start();
  });
}
