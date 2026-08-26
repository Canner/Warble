# BIRD-Interact data boundary

This directory is the local-only boundary for BIRD-Interact evaluation data. Everything here is ignored except `.gitignore` and this README; do not add secrets, placeholders, or evaluation data to the repository.

## Local tree

```text
private/
  bird_interact_gt_kg_testcases_1008.jsonl  # official gated GT
  .env                                     # optional local credentials/configuration
cache/
  BIRD-Interact/
  bird-interact-lite/_warble-source.json
  wren-cli/
runtime/
  bird_interact_data_with_gt.jsonl
  smoke-alien-5.jsonl
  identity-projects/alien/target/mdl.json
  manifest.json
runs/
  alien-5/
  alien-5-greedy/
```

Every `alien` above is the default database's name, not a fixed one: preparing with `--database polar` renames all of them — `smoke-polar-5.jsonl`, `identity-projects/polar/target/mdl.json`, `runs/polar-5/`. A run directory is named for that database and the promoted task count; a profile other than the shipped baseline appends its label, so `--profile agents/greedy` writes `runs/alien-5-greedy/` beside the baseline's run rather than displacing it.

The official ground truth (GT) is obtained only through BIRD's official gated process. Public-snapshot acquisition never fetches it: that path downloads the pinned public file list and nothing else, and `--public-data <file>` only substitutes a local copy of `bird_interact_data.jsonl` for that one download. GT reaches this tree solely through `--gt <file>`, which points preparation at your own gated copy; preparation copies it into `private/` with mode `0600`. `private/.env` is optional. Local data is not a score source unless the preparation manifest validates it.

Public-data provenance is pinned to official code commit `451fe2c3518ee1cf908d8139e2913483bd519381` and HF commit `f7881a9c2b9630cc4fc13b0c39279740b0a2fd87`. The immutable HF tree/resolve acquisition is pinned to:

- https://huggingface.co/api/datasets/birdsql/bird-interact-lite/tree/f7881a9c2b9630cc4fc13b0c39279740b0a2fd87?recursive=true&limit=1000
- https://huggingface.co/datasets/birdsql/bird-interact-lite/resolve/f7881a9c2b9630cc4fc13b0c39279740b0a2fd87

The main public archive has SHA256 `d155fa0855bc1885f77df2fcc357d3056e10426cd6093c0042aa99d79067af08`.

Preparation downloads the required per-database schema, column-meaning, and KB metadata (knowledge-base metadata). It validates the preparation manifest before scoring. The private/ GT, cache/, runtime/, and runs/ trees remain local-only.
