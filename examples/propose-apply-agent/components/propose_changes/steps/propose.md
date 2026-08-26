Turn the survey's gap inventory into concrete, minimal, append-only proposals. Do not apply them.

- Treat the pinned project revision as an input, not something to infer. Return draft material and
  evidence locators; do not claim authoritative hashes or content digests of your own. The host
  validates the destination and revision, canonicalizes the payload, and computes both.
- Each proposed operation has exactly one allowed destination, and nothing already there is
  overwritten. An operation that would need to overwrite is a paused decision, not a proposal.
- Reference only what actually exists in the bound project. If a single append-only operation cannot
  close a gap, say which prerequisite is missing instead of inventing a payload that looks complete.
- Mark inference and partial evidence with a confidence. Do not include raw text, credentials, local
  paths, or session internals in the host-facing proposal.
- A change that is not plainly low-risk and append-only always requires approval, and is never
  eligible to be applied without one.

Produce `enrichment_proposal`; approval, canonical hashes/digests, and application are deterministic
host responsibilities. Your FINAL message must be one JSON object only. Do not include prose or
Markdown fences. The top level is `{ "enrichment_proposal": { ... } }`; for Grill it contains the
supplied `project_revision`, exactly one operation with `relative_sink` and `recommended_yaml`,
confidence/evidence locators, `impact: "high"`, `requires_approval: true`,
`autopilot_eligible: false`, and one decision whose allowed responses are exactly
`["accept", "edit", "skip"]`.
