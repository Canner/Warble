Read the raw business docs bound at `{{project}}` and extract the enrichable facts.

Pull out the business semantics that a semantic layer cannot infer from schema alone: units (e.g.
"amount is USD"), enum meanings (what each `status` value means), and definitions (what counts as a
"completed order"). Report them as `doc_facts`. Read-only: do not write any file in this step.
