# Run diffing

Two runs of the **same pipeline** can be compared structurally and at the
content level. This is part of Phase 5 (cross-run reasoning). It is a CLI + REST
feature only — it does **not** add to the 8-tool MCP/openai surface.

## What is compared

`diffRuns(a, b)` (in `@llm-pipe/core`, `packages/core/src/diff/RunDiffer.ts`)
produces a structured `RunDiff` covering:

- **Channels present** — which channels (and the synthesis channel) appear in
  each run; channels present in only one run are flagged `only_a` / `only_b`.
- **Channel statuses** — `ok`, `invalid_json`, `schema_error`, etc.
- **Validation outcomes** — per-channel `schemaValid` and the run-level
  `validation.valid`.
- **Provider** and **model** per channel.
- **Parsed output** — a schema-aware, key-level diff. Objects and arrays are
  walked recursively; leaves are reported by JSON path as `added` / `removed` /
  `changed`. Arrays are compared positionally.
- **Cost** — per-channel `usage.costUsd` and a run-level total, with deltas.
- **Latency** — per-channel `latencyMs` with deltas.

The diff also reports `identical: true` when nothing changed across run status,
validation, and every channel.

## Refuse-to-diff

If the two runs have different `source.pipelineHash`, they are runs of different
pipeline definitions and a key-level diff would be meaningless. `diffRuns`
throws `RunDiffError` (`code: "pipeline_mismatch"`); `tryDiffRuns` instead
returns a `RunDiff` with `comparable: false` and a `reason` string explaining the
refusal.

## Out of scope

- N-way diff (only 2-way).
- UI rendering.
- Semantic diff of free-text channel outputs (only structural and key-level).

## CLI

```sh
llm-pipe --store sqlite:.runs/runs.sqlite diff <run-id-a> <run-id-b>
llm-pipe diff <run-id-a> <run-id-b> --format json
```

Default output is markdown (`renderDiffMarkdown`). `--format json` emits the raw
`RunDiff`. On a pipeline mismatch the CLI prints the refusal to stderr and exits
non-zero.

## REST

```
GET /runs/:idA/diff/:idB
```

Returns the `RunDiff` JSON. `404` if either run is unknown; `409` with a
structured `pipeline_mismatch` body when the runs are of different pipelines.
This folds into the existing run-inspection REST surface; no new MCP/openai tool
is introduced.
