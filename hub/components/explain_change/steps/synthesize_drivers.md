Given the `decomposition_plan`, quantify the change and synthesize the drivers into an explanation.

- Run the decomposition queries through the `wren` CLI (`wren -q -o json -s '<SQL>'`): compute the
  metric for each period and the per-dimension contribution to the delta. Rank contributors by the
  size of their contribution.
- Produce `driver_explanation` as a `narrative` render block: a short, ordered account of what drove
  the change (largest contributors first), with the actual numbers. Follow the "Render output"
  instructions the dispatcher appends below.
- **Additivity caveat (required):** if the metric is not strictly additive across the decomposition
  dimensions, state plainly in the narrative that the attribution is approximate and additivity was
  not enforced. Never present a decomposition of a non-additive metric as exact — the hero output
  must not claim to run on verified reasoning it did not.
