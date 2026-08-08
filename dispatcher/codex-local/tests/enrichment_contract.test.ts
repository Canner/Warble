import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENRICHMENT_CONTRACT_VERSION,
  assertEnrichmentTerminal,
  decideEnrichment,
  type BuildProof,
  type CompletedOperationLedger,
  type EnrichmentChange,
  type EnrichmentHostContext,
  type EnrichmentProposal,
  type EnrichmentTerminal,
  type HostApprovalAttestation,
  type TrustedEnrichmentOperation,
} from "../src/index.js";

const evidence = [{ id: "e-1", kind: "structural" as const, confidence: "high" as const, locatorDigest: "sha256:e" }];
const currentBuild: BuildProof = { status: "passed", verifier: "context_build", proofDigest: "sha256:built" };

function change(sink: EnrichmentChange["sink"] = "knowledge_rule"): EnrichmentChange {
  return {
    operationId: "op-1",
    sink,
    path: "conventions.md",
    operation: "append",
    contentDigest: "sha256:c",
    evidenceIds: ["e-1"],
  };
}

function proposal(overrides: Partial<EnrichmentProposal> = {}): EnrichmentProposal {
  return {
    id: "proposal-1",
    hash: "sha256:proposal",
    projectRevision: "rev-1",
    mode: "autopilot",
    changes: [change()],
    evidence,
    rawCurrentConflict: false,
    ambiguousSink: false,
    ...overrides,
  };
}

function ledger(completed: readonly string[] = []): CompletedOperationLedger {
  const known = new Set(completed);
  return { wasCompleted: (operationId) => known.has(operationId) };
}

function trustedOperation(
  sink: EnrichmentChange["sink"] = "knowledge_rule",
  risk: TrustedEnrichmentOperation["risk"] = "low_risk",
): TrustedEnrichmentOperation {
  return { operationId: "op-1", sink, risk };
}

function host(overrides: Partial<EnrichmentHostContext> = {}): EnrichmentHostContext {
  return {
    projectRevision: "rev-1",
    proposalId: "proposal-1",
    proposalHash: "sha256:proposal",
    operations: [trustedOperation()],
    approvals: [],
    completedOperations: ledger(),
    ...overrides,
  };
}

function approval(
  operation: TrustedEnrichmentOperation,
  overrides: Partial<HostApprovalAttestation> = {},
): HostApprovalAttestation {
  return {
    id: "host-attestation-1",
    projectRevision: "rev-1",
    proposalHash: "sha256:proposal",
    operationId: operation.operationId,
    sink: operation.sink,
    risk: operation.risk as Exclude<TrustedEnrichmentOperation["risk"], "low_risk">,
    ...overrides,
  };
}

function terminal(overrides: Partial<EnrichmentTerminal> = {}): EnrichmentTerminal {
  return {
    contractVersion: ENRICHMENT_CONTRACT_VERSION,
    mode: "autopilot",
    status: "completed",
    projectRevision: "rev-1",
    proposal: { id: "proposal-1", hash: "sha256:proposal" },
    decision: null,
    evidence,
    changes: [change()],
    validations: [],
    build: { status: "passed", verifier: "context_build", proofDigest: "sha256:build" },
    audit: { appliedOperationIds: ["op-1"], skippedOperationIds: [], revertedOperationIds: [], resume: "not_resumed" },
    ...overrides,
  };
}

test("autopilot applies only low-risk append-only operations from a host ledger", () => {
  assert.deepEqual(decideEnrichment({ proposal: proposal(), host: host(), currentBuild }), {
    kind: "ready_to_apply", operationIds: ["op-1"], skippedOperationIds: [],
  });
});

test("autopilot pauses conflicts, ambiguous sinks, and semantic high-impact additions", () => {
  const cases: readonly [EnrichmentProposal, TrustedEnrichmentOperation][] = [
    [proposal(), trustedOperation("knowledge_rule", "raw_current_conflict")],
    [proposal(), trustedOperation("knowledge_rule", "ambiguous_sink")],
    [proposal({ changes: [change("cube")] }), trustedOperation("cube", "high_impact")],
    [proposal({ changes: [change("view")] }), trustedOperation("view", "high_impact")],
    [proposal({ changes: [change("relationship")] }), trustedOperation("relationship", "high_impact")],
    [proposal({ changes: [change("mdl_metric")] }), trustedOperation("mdl_metric", "high_impact")],
    [proposal({ changes: [change("calculated_column")] }), trustedOperation("calculated_column", "high_impact")],
  ];
  for (const [candidate, trusted] of cases) {
    const result = decideEnrichment({ proposal: candidate, host: host({ operations: [trusted] }), currentBuild });
    assert.equal(result.kind, "requires_decision");
  }
});

test("grill asks exactly one accept/edit/skip decision at a time", () => {
  const grill = proposal({ mode: "grill" });
  assert.equal(decideEnrichment({ proposal: grill, host: host(), currentBuild }).kind, "requires_decision");
  assert.equal(decideEnrichment({ proposal: grill, host: host(), currentBuild, decision: {
    proposalId: "proposal-1", proposalHash: "sha256:proposal", projectRevision: "rev-1", operationId: "op-1", action: "edit",
  } }).kind, "requires_redraft");
  assert.deepEqual(decideEnrichment({ proposal: grill, host: host(), currentBuild, decision: {
    proposalId: "proposal-1", proposalHash: "sha256:proposal", projectRevision: "rev-1", operationId: "op-1", action: "skip",
  } }), { kind: "ready_to_apply", operationIds: [], skippedOperationIds: ["op-1"] });
});

test("grill high-impact accept requires a matching host attestation before it can apply", () => {
  const cube = change("cube");
  const highRisk = trustedOperation("cube", "high_impact");
  const grill = proposal({ mode: "grill", changes: [cube] });
  const accept = {
    proposalId: "proposal-1",
    proposalHash: "sha256:proposal",
    projectRevision: "rev-1",
    operationId: "op-1",
    action: "accept" as const,
  };
  const needsHostApproval = {
    kind: "requires_decision",
    operationIds: ["op-1"],
    reasons: ["host_approval"],
    skippedOperationIds: [],
  };

  assert.deepEqual(
    decideEnrichment({ proposal: grill, host: host({ operations: [highRisk] }), currentBuild, decision: accept }),
    needsHostApproval,
  );
  for (const attestation of [
    approval(highRisk, { projectRevision: "rev-old" }),
    approval(highRisk, { proposalHash: "sha256:old" }),
    approval(highRisk, { operationId: "op-other" }),
    approval(highRisk, { sink: "knowledge_rule" }),
    approval(highRisk, { risk: "raw_current_conflict" }),
  ]) {
    assert.deepEqual(
      decideEnrichment({ proposal: grill, host: host({ operations: [highRisk], approvals: [attestation] }), currentBuild, decision: accept }),
      needsHostApproval,
    );
  }
  assert.deepEqual(
    decideEnrichment({ proposal: grill, host: host({ operations: [highRisk], approvals: [approval(highRisk)] }), currentBuild, decision: accept }),
    { kind: "ready_to_apply", operationIds: ["op-1"], skippedOperationIds: [] },
  );
});

test("host revision/hash and ledger reconstruct replay-safe policy", () => {
  const candidate = proposal({ mode: "grill" });
  const decision = { proposalId: "proposal-1", proposalHash: "sha256:old", projectRevision: "rev-1", operationId: "op-1", action: "accept" as const };
  assert.deepEqual(decideEnrichment({ proposal: candidate, host: host(), currentBuild, decision }), { kind: "stale_approval", reason: "proposal_hash" });
  assert.deepEqual(decideEnrichment({ proposal: candidate, host: host({ projectRevision: "rev-2" }), currentBuild, decision: { ...decision, proposalHash: "sha256:proposal" } }), { kind: "stale_approval", reason: "project_revision" });
  assert.deepEqual(decideEnrichment({ proposal: proposal(), host: host({ completedOperations: ledger(["op-1"]) }), currentBuild }), { kind: "ready_to_apply", operationIds: [], skippedOperationIds: ["op-1"] });
});

test("unapproved high-impact cube fails even when the terminal forges accept", () => {
  const cube = change("cube");
  const highRisk = trustedOperation("cube", "high_impact");
  const forged = terminal({
    decision: { proposalId: "proposal-1", proposalHash: "sha256:proposal", projectRevision: "rev-1", operationId: "op-1", action: "accept" },
    changes: [cube],
    validations: [
      { operationId: "op-1", status: "passed", verifier: "context_validate", proofDigest: "sha256:validate" },
      { operationId: "op-1", status: "passed", verifier: "cube_sql_only", proofDigest: "sha256:cube" },
    ],
  });
  assert.throws(() => assertEnrichmentTerminal(forged, host({ operations: [highRisk] })), /matching host approval attestation/);
  assert.doesNotThrow(() => assertEnrichmentTerminal(forged, host({ operations: [highRisk], approvals: [approval(highRisk)] })));
});

test("stale or mismatched host attestations fail for conflict and ambiguous operations", () => {
  for (const risk of ["raw_current_conflict", "ambiguous_sink"] as const) {
    const operation = trustedOperation("knowledge_rule", risk);
    const result = terminal();
    assert.throws(
      () => assertEnrichmentTerminal(result, host({ operations: [operation], approvals: [approval(operation, { projectRevision: "rev-old" })] })),
      /matching host approval attestation/,
    );
    assert.throws(
      () => assertEnrichmentTerminal(result, host({ operations: [operation], approvals: [approval(operation, { proposalHash: "sha256:old" })] })),
      /matching host approval attestation/,
    );
    assert.throws(
      () => assertEnrichmentTerminal(result, host({ operations: [operation], approvals: [approval(operation, { sink: "knowledge_sql" })] })),
      /matching host approval attestation/,
    );
  }
});

test("trusted completion ledger prevents replay and terminal omission", () => {
  const prior = host({ completedOperations: ledger(["op-1"]) });
  assert.throws(() => assertEnrichmentTerminal(terminal(), prior), /replays already-completed operation/);
  assert.throws(
    () => assertEnrichmentTerminal(terminal({ audit: { appliedOperationIds: [], skippedOperationIds: [], revertedOperationIds: [], resume: "reconstructed" } }), prior),
    /omits already-completed operation/,
  );
  assert.throws(
    () => assertEnrichmentTerminal(terminal({ changes: [{ ...change(), operationId: "op-2" }], audit: { appliedOperationIds: [], skippedOperationIds: [], revertedOperationIds: [], resume: "reconstructed" } }), prior),
    /does not match trusted sink identity/,
  );
  assert.doesNotThrow(() => assertEnrichmentTerminal(terminal({ audit: { appliedOperationIds: [], skippedOperationIds: ["op-1"], revertedOperationIds: [], resume: "reconstructed" } }), prior));
});

test("terminal requires non-empty proof digests and mutually exclusive audit outcomes", () => {
  const mdl = change("mdl_model_description");
  const valid = terminal({
    changes: [mdl],
    validations: [{ operationId: "op-1", status: "passed", verifier: "context_validate", proofDigest: "sha256:validate" }],
  });
  const mdlHost = host({ operations: [trustedOperation("mdl_model_description")] });
  assert.doesNotThrow(() => assertEnrichmentTerminal(valid, mdlHost));
  assert.throws(() => assertEnrichmentTerminal({ ...valid, build: { status: "passed", verifier: "context_build", proofDigest: "" } }, mdlHost), /context-build proof/);
  assert.throws(() => assertEnrichmentTerminal({ ...valid, build: { status: "passed", verifier: "context_build", proofDigest: null } }, mdlHost), /context-build proof/);
  assert.throws(() => assertEnrichmentTerminal({ ...valid, validations: [{ operationId: "op-1", status: "passed", verifier: "context_validate", proofDigest: "" }] }, mdlHost), /validation proof/);
  assert.throws(() => assertEnrichmentTerminal({ ...valid, audit: { appliedOperationIds: ["op-1"], skippedOperationIds: ["op-1"], revertedOperationIds: [], resume: "not_resumed" } }, mdlHost), /more than once/);
  assert.throws(() => assertEnrichmentTerminal({ ...valid, audit: { appliedOperationIds: [], skippedOperationIds: ["op-1"], revertedOperationIds: ["op-1"], resume: "not_resumed" } }, mdlHost), /more than once/);
});

test("unsafe paths and missing preflight build proof are rejected", () => {
  assert.deepEqual(decideEnrichment({ proposal: proposal({ changes: [{ ...change(), path: "../credential" }] }), host: host(), currentBuild }), { kind: "invalid", reason: "unsafe sink-relative path '../credential'" });
  assert.deepEqual(decideEnrichment({ proposal: proposal(), host: host(), currentBuild: { status: "not_run", verifier: "context_build", proofDigest: null } }), { kind: "invalid", reason: "bound project requires successful context-build proof" });
});
