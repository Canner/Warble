/**
 * Host-verifiable contract for a bound-project enrichment run.
 *
 * This is deliberately a pure contract, not a Codex runtime implementation. The current local
 * target has no human-approval callback for gated writes, so callers can draft and validate this
 * envelope but must wall-hit before attempting to execute it. A host that later provides approval
 * and sink-scoped tools can use the same deterministic policy without exposing raw material,
 * credentials, provider session ids, or project-side state files.
 */

export const ENRICHMENT_CONTRACT_VERSION = "1" as const;

export const ENRICHMENT_SINKS = [
  "mdl_model_description",
  "mdl_column_description",
  "knowledge_rule",
  "knowledge_sql",
  "cube",
  "view",
  "relationship",
  "mdl_metric",
  "calculated_column",
] as const;

export type EnrichmentSink = (typeof ENRICHMENT_SINKS)[number];
export type EnrichmentMode = "grill" | "autopilot";
export type EnrichmentConfidence = "high" | "medium" | "low";
export type EnrichmentStatus = "completed" | "paused_for_decision" | "rejected" | "failed";
export type EnrichmentDecisionAction = "accept" | "edit" | "skip";
export type EnrichmentOperationRisk =
  | "low_risk"
  | "high_impact"
  | "raw_current_conflict"
  | "ambiguous_sink";

const HIGH_IMPACT_SINKS: ReadonlySet<EnrichmentSink> = new Set([
  "cube",
  "view",
  "relationship",
  "mdl_metric",
  "calculated_column",
]);

const LOW_RISK_SINKS: ReadonlySet<EnrichmentSink> = new Set([
  "mdl_model_description",
  "mdl_column_description",
  "knowledge_rule",
  "knowledge_sql",
]);

export interface EnrichmentEvidence {
  /** Opaque reference, never a raw excerpt or credential-bearing path. */
  id: string;
  kind: "structural" | "raw_claim" | "inference" | "probe";
  confidence: EnrichmentConfidence;
  /** A non-sensitive locator/digest supplied by the executor, never source content. */
  locatorDigest: string;
}

export interface EnrichmentChange {
  operationId: string;
  sink: EnrichmentSink;
  /** Relative path inside the selected sink, never an absolute/workspace path. */
  path: string;
  /** Enrichment is append-only; replacements are never representable. */
  operation: "append";
  /** Opaque canonical digest of executor-held content; raw payload stays out of this contract. */
  contentDigest: string;
  evidenceIds: string[];
}

export interface EnrichmentProposal {
  id: string;
  hash: string;
  projectRevision: string;
  mode: EnrichmentMode;
  changes: EnrichmentChange[];
  evidence: EnrichmentEvidence[];
  rawCurrentConflict: boolean;
  ambiguousSink: boolean;
}

export interface EnrichmentDecision {
  proposalId: string;
  proposalHash: string;
  projectRevision: string;
  operationId: string;
  action: EnrichmentDecisionAction;
}

/** A pending request is an identity-bearing terminal state, not prose asking for approval. */
export interface EnrichmentDecisionRequest {
  id: string;
  proposalId: string;
  proposalHash: string;
  projectRevision: string;
  operationId: string;
  action: "pending";
}

/**
 * A host-issued approval record. It is supplied out-of-band to validation; no model output,
 * terminal decision, secret, or model-generated signature can stand in for this record.
 */
export interface HostApprovalAttestation {
  id: string;
  projectRevision: string;
  proposalHash: string;
  operationId: string;
  sink: EnrichmentSink;
  risk: Exclude<EnrichmentOperationRisk, "low_risk">;
}

/** The host's canonical operation classification, never copied from a terminal envelope. */
export interface TrustedEnrichmentOperation {
  operationId: string;
  sink: EnrichmentSink;
  risk: EnrichmentOperationRisk;
}

/**
 * Snapshot of operations completed before the terminal being checked. A host may back this with a
 * durable ledger or reconstruct it from an authoritative audit stream after provider-session loss.
 */
export interface CompletedOperationLedger {
  wasCompleted(operationId: string): boolean;
}

/** Trusted, host-owned inputs required to validate a terminal envelope. */
export interface EnrichmentHostContext {
  projectRevision: string;
  proposalId: string;
  proposalHash: string;
  operations: readonly TrustedEnrichmentOperation[];
  approvals: readonly HostApprovalAttestation[];
  completedOperations: CompletedOperationLedger;
}

export interface ValidationProof {
  operationId: string;
  status: "passed" | "failed" | "not_required";
  verifier: "context_validate" | "cube_sql_only";
  proofDigest: string;
}

export interface BuildProof {
  status: "passed" | "failed" | "not_run";
  verifier: "context_build";
  proofDigest: string | null;
}

export interface EnrichmentAudit {
  appliedOperationIds: string[];
  skippedOperationIds: string[];
  revertedOperationIds: string[];
  /** Resume state is host-owned; no gaps/state artifact is ever written in the project. */
  resume: "provider_session" | "reconstructed" | "not_resumed";
}

export interface EnrichmentTerminal {
  contractVersion: typeof ENRICHMENT_CONTRACT_VERSION;
  mode: EnrichmentMode;
  status: EnrichmentStatus;
  projectRevision: string;
  proposal: Pick<EnrichmentProposal, "id" | "hash">;
  decision: EnrichmentDecision | EnrichmentDecisionRequest | null;
  evidence: EnrichmentEvidence[];
  changes: EnrichmentChange[];
  validations: ValidationProof[];
  build: BuildProof;
  audit: EnrichmentAudit;
}

export type EnrichmentDisposition =
  | { kind: "ready_to_apply"; operationIds: string[]; skippedOperationIds: string[] }
  | { kind: "requires_decision"; operationIds: string[]; reasons: string[]; skippedOperationIds: string[] }
  | { kind: "requires_redraft"; operationId: string }
  | { kind: "stale_approval"; reason: "project_revision" | "proposal_hash" | "proposal_id" }
  | { kind: "invalid"; reason: string };

export interface EnrichmentPolicyInput {
  proposal: EnrichmentProposal;
  host: EnrichmentHostContext;
  /** Successful build proof captured before the enrichment run starts. */
  currentBuild: BuildProof;
  decision?: EnrichmentDecision;
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function isHighImpact(change: EnrichmentChange): boolean {
  return HIGH_IMPACT_SINKS.has(change.sink);
}

function isMdlChange(change: EnrichmentChange): boolean {
  return change.sink !== "knowledge_rule" && change.sink !== "knowledge_sql";
}

function validateProposal(proposal: EnrichmentProposal): string | null {
  if (proposal.id.length === 0 || proposal.hash.length === 0 || proposal.projectRevision.length === 0) {
    return "proposal identity and project revision must be non-empty";
  }
  if (proposal.changes.length === 0) return "proposal must contain at least one change";
  const ids = new Set<string>();
  const evidenceIds = new Set(proposal.evidence.map((evidence) => evidence.id));
  for (const change of proposal.changes) {
    if (ids.has(change.operationId)) return `duplicate operation id '${change.operationId}'`;
    ids.add(change.operationId);
    if (!ENRICHMENT_SINKS.includes(change.sink)) return `unsupported sink '${change.sink}'`;
    if (change.operation !== "append") return "enrichment changes must be append-only";
    if (!isSafeRelativePath(change.path)) return `unsafe sink-relative path '${change.path}'`;
    if (change.contentDigest.length === 0) return `operation '${change.operationId}' is missing contentDigest`;
    if (change.evidenceIds.some((id) => !evidenceIds.has(id))) {
      return `operation '${change.operationId}' references unknown evidence`;
    }
  }
  for (const evidence of proposal.evidence) {
    if (evidence.id.length === 0 || evidence.locatorDigest.length === 0) {
      return "evidence must use non-empty opaque ids and digests";
    }
  }
  return null;
}

function staleDecision(
  proposal: EnrichmentProposal,
  decision: EnrichmentDecision,
): EnrichmentDisposition | null {
  if (decision.proposalId !== proposal.id) return { kind: "stale_approval", reason: "proposal_id" };
  if (decision.proposalHash !== proposal.hash) return { kind: "stale_approval", reason: "proposal_hash" };
  if (decision.projectRevision !== proposal.projectRevision) {
    return { kind: "stale_approval", reason: "project_revision" };
  }
  return null;
}

/**
 * Pure policy for one proposal. It makes the native grill/autopilot split inspectable by a host:
 * completed operation ids are removed before dispatch, making a reconstructed resume replay-safe.
 */
export function decideEnrichment(input: EnrichmentPolicyInput): EnrichmentDisposition {
  const { proposal, host, currentBuild, decision } = input;
  const invalid = validateProposal(proposal);
  if (invalid) return { kind: "invalid", reason: invalid };
  if (currentBuild.verifier !== "context_build" || currentBuild.status !== "passed" || !currentBuild.proofDigest) {
    return { kind: "invalid", reason: "bound project requires successful context-build proof" };
  }
  if (proposal.projectRevision !== host.projectRevision) {
    return { kind: "stale_approval", reason: "project_revision" };
  }
  if (proposal.id !== host.proposalId) return { kind: "stale_approval", reason: "proposal_id" };
  if (proposal.hash !== host.proposalHash) return { kind: "stale_approval", reason: "proposal_hash" };
  let trusted: Map<string, TrustedEnrichmentOperation>;
  try {
    trusted = trustedOperationsById(host);
  } catch (error) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  if (trusted.size !== proposal.changes.length) {
    return { kind: "invalid", reason: "proposal operations must match trusted host operations exactly" };
  }
  for (const change of proposal.changes) {
    const operation = trusted.get(change.operationId);
    if (!operation || operation.sink !== change.sink) {
      return { kind: "invalid", reason: `proposal operation '${change.operationId}' does not match trusted sink identity` };
    }
  }
  if (decision) {
    const stale = staleDecision(proposal, decision);
    if (stale) return stale;
  }

  const pending = proposal.changes.filter((change) => !host.completedOperations.wasCompleted(change.operationId));
  const skippedOperationIds = proposal.changes
    .filter((change) => host.completedOperations.wasCompleted(change.operationId))
    .map((change) => change.operationId);
  if (pending.length === 0) return { kind: "ready_to_apply", operationIds: [], skippedOperationIds };

  if (proposal.mode === "grill") {
    if (pending.length !== 1) {
      return { kind: "invalid", reason: "grill requires exactly one unresolved operation per decision" };
    }
    const change = pending[0]!;
    if (!decision) {
      return { kind: "requires_decision", operationIds: [change.operationId], reasons: ["grill_mode"], skippedOperationIds };
    }
    if (decision.operationId !== change.operationId) {
      return { kind: "invalid", reason: "grill decision must address the single unresolved operation" };
    }
    if (decision.action === "skip") {
      return { kind: "ready_to_apply", operationIds: [], skippedOperationIds: [...skippedOperationIds, change.operationId] };
    }
    if (decision.action === "edit") return { kind: "requires_redraft", operationId: change.operationId };
    if (!hasMatchingApproval(host, trusted.get(change.operationId)!)) {
      return {
        kind: "requires_decision",
        operationIds: [change.operationId],
        reasons: ["host_approval"],
        skippedOperationIds,
      };
    }
    return { kind: "ready_to_apply", operationIds: [change.operationId], skippedOperationIds };
  }

  const reasons: string[] = [];
  if (pending.some((change) => trusted.get(change.operationId)!.risk === "raw_current_conflict")) {
    reasons.push("raw_current_conflict");
  }
  if (pending.some((change) => trusted.get(change.operationId)!.risk === "ambiguous_sink")) {
    reasons.push("ambiguous_sink");
  }
  if (pending.some((change) => trusted.get(change.operationId)!.risk === "high_impact" || isHighImpact(change))) {
    reasons.push("high_impact_sink");
  }
  if (reasons.length > 0) {
    return { kind: "requires_decision", operationIds: pending.map((change) => change.operationId), reasons, skippedOperationIds };
  }
  if (pending.some((change) => !LOW_RISK_SINKS.has(change.sink))) {
    return { kind: "invalid", reason: "autopilot can apply only known low-risk sinks" };
  }
  return { kind: "ready_to_apply", operationIds: pending.map((change) => change.operationId), skippedOperationIds };
}

function hasNonEmptyDigest(proof: { proofDigest: string | null }): boolean {
  return typeof proof.proofDigest === "string" && proof.proofDigest.trim().length > 0;
}

function trustedOperationsById(host: EnrichmentHostContext): Map<string, TrustedEnrichmentOperation> {
  const operations = new Map<string, TrustedEnrichmentOperation>();
  for (const operation of host.operations) {
    if (operations.has(operation.operationId)) {
      throw new Error(`host context has duplicate operation '${operation.operationId}'`);
    }
    operations.set(operation.operationId, operation);
  }
  return operations;
}

function hasMatchingApproval(
  host: EnrichmentHostContext,
  operation: TrustedEnrichmentOperation,
): boolean {
  if (operation.risk === "low_risk") return true;
  return host.approvals.some(
    (approval) =>
      approval.id.length > 0 &&
      approval.projectRevision === host.projectRevision &&
      approval.proposalHash === host.proposalHash &&
      approval.operationId === operation.operationId &&
      approval.sink === operation.sink &&
      approval.risk === operation.risk,
  );
}

/**
 * Validates a terminal against trusted host context. Terminal decisions are display/audit data only:
 * they are never authority to apply a high-risk operation or to suppress a prior-completion ledger.
 */
export function assertEnrichmentTerminal(terminal: EnrichmentTerminal, host: EnrichmentHostContext): void {
  if (terminal.contractVersion !== ENRICHMENT_CONTRACT_VERSION) {
    throw new Error(`unsupported enrichment contract version '${terminal.contractVersion}'`);
  }
  const invalid = validateProposal({
    id: terminal.proposal.id,
    hash: terminal.proposal.hash,
    projectRevision: terminal.projectRevision,
    mode: terminal.mode,
    changes: terminal.changes,
    evidence: terminal.evidence,
    rawCurrentConflict: false,
    ambiguousSink: false,
  });
  if (invalid) throw new Error(`invalid enrichment terminal: ${invalid}`);
  if (terminal.projectRevision !== host.projectRevision) {
    throw new Error("terminal project revision does not match trusted host context");
  }
  if (terminal.proposal.id !== host.proposalId || terminal.proposal.hash !== host.proposalHash) {
    throw new Error("terminal proposal does not match trusted host context");
  }
  if (terminal.decision && terminal.decision.projectRevision !== host.projectRevision) {
    throw new Error("terminal decision is stale for the recorded project revision");
  }
  if (
    terminal.decision &&
    (terminal.decision.proposalId !== terminal.proposal.id ||
      terminal.decision.proposalHash !== terminal.proposal.hash)
  ) {
    throw new Error("terminal decision does not match the recorded proposal identity");
  }
  const applied = new Set(terminal.audit.appliedOperationIds);
  const skipped = new Set(terminal.audit.skippedOperationIds);
  const reverted = new Set(terminal.audit.revertedOperationIds);
  const trusted = trustedOperationsById(host);
  const terminalOperations = new Map(terminal.changes.map((change) => [change.operationId, change]));
  if (terminalOperations.size !== terminal.changes.length || terminalOperations.size !== trusted.size) {
    throw new Error("terminal operations must match trusted host operations exactly");
  }
  for (const [operationId, operation] of terminalOperations) {
    const trustedOperation = trusted.get(operationId);
    if (!trustedOperation || trustedOperation.sink !== operation.sink) {
      throw new Error(`terminal operation '${operationId}' does not match trusted sink identity`);
    }
  }
  for (const operationId of [...applied, ...skipped, ...reverted]) {
    if (!trusted.has(operationId)) {
      throw new Error(`terminal audit refers to unknown operation '${operationId}'`);
    }
  }
  for (const operationId of trusted.keys()) {
    const auditMembership = Number(applied.has(operationId)) + Number(skipped.has(operationId)) + Number(reverted.has(operationId));
    if (auditMembership > 1) {
      throw new Error(`terminal audit records operation '${operationId}' more than once`);
    }
    if (host.completedOperations.wasCompleted(operationId)) {
      if (applied.has(operationId) || reverted.has(operationId)) {
        throw new Error(`terminal replays already-completed operation '${operationId}'`);
      }
      if (!skipped.has(operationId)) {
        throw new Error(`terminal omits already-completed operation '${operationId}' from its audit`);
      }
    }
  }
  for (const change of terminal.changes) {
    const operation = trusted.get(change.operationId)!;
    const executed = applied.has(change.operationId) || reverted.has(change.operationId);
    if (executed && !hasMatchingApproval(host, operation)) {
      throw new Error(`operation '${change.operationId}' requires matching host approval attestation`);
    }
    if (isMdlChange(change) && applied.has(change.operationId)) {
      const validate = terminal.validations.find(
        (candidate) => candidate.operationId === change.operationId && candidate.verifier === "context_validate",
      );
      if (!validate || validate.status !== "passed" || !hasNonEmptyDigest(validate)) {
        throw new Error(`applied MDL operation '${change.operationId}' lacks successful validation proof`);
      }
      if (change.sink === "cube") {
        const cubeQuery = terminal.validations.find(
          (candidate) => candidate.operationId === change.operationId && candidate.verifier === "cube_sql_only",
        );
        if (!cubeQuery || cubeQuery.status !== "passed" || !hasNonEmptyDigest(cubeQuery)) {
          throw new Error(`applied cube operation '${change.operationId}' lacks successful cube query proof`);
        }
      }
    }
  }
  for (const proof of terminal.validations) {
    if (proof.status === "passed" && !hasNonEmptyDigest(proof)) {
      throw new Error(`successful validation proof for '${proof.operationId}' is missing a digest`);
    }
  }
  if (terminal.status === "completed" && (terminal.build.status !== "passed" || !hasNonEmptyDigest(terminal.build))) {
    throw new Error("completed enrichment requires successful context-build proof");
  }
  if (terminal.status === "completed") {
    for (const change of terminal.changes) {
      if (!applied.has(change.operationId) && !skipped.has(change.operationId) && !reverted.has(change.operationId)) {
        throw new Error(`completed enrichment has no audit outcome for '${change.operationId}'`);
      }
    }
  }
  if (
    terminal.status === "paused_for_decision" &&
    (terminal.decision === null || terminal.decision.action !== "pending")
  ) {
    throw new Error("paused enrichment must expose an identity-bearing pending decision request");
  }
}
