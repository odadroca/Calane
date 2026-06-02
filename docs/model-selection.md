# Model-selection harness

The model-selection harness runs the **same pipeline** across several providers,
`N` times each, and ranks them empirically on validation pass rate, structural
conformance, cost, and latency. It is decision support — not a marketplace and
not runtime provider switching (both explicitly out of scope). This is a CLI +
core feature only and does **not** add to the 8-tool MCP/openai surface.

## What it measures

For each provider, across its `N` runs (`ModelSelector` in
`packages/core/src/selection/ModelSelector.ts`):

- **validationPassRate** — fraction of runs whose overall validation passed.
- **structuralConformance** — fraction of channels (across all runs) with
  `schemaValid === true`.
- **meanCostUsd** — mean total cost per run (null when no provider reported
  cost).
- **meanLatencyMs** — mean total latency per run.
- **errors** — runs that threw during execution (counted as failures).

## Ranking

A composite score combines the four signals with configurable weights. Higher
validation/conformance is better; lower cost/latency is better (cost and latency
are normalized to `[0,1]` across the compared providers and inverted). Default
weights:

| signal | weight |
| --- | --- |
| validation | 0.40 |
| conformance | 0.30 |
| cost | 0.15 |
| latency | 0.15 |

Any subset of weights can be overridden; omitted weights fall back to the
defaults. The provider with the highest score is the `recommendation`.

## CLI

```sh
llm-pipe select-model \
  --pipeline swot_recursive \
  --input ./topic.md \
  --providers mock,openai \
  --runs 5
```

Weight overrides:

```sh
llm-pipe select-model --pipeline swot_recursive --input ./topic.md \
  --providers mock,openai --runs 5 \
  --weight-validation 0.5 --weight-cost 0.3 --weight-latency 0.2 --weight-conformance 0
```

Output is a plain ASCII table with a ranked recommendation; pass `--json` for the
raw structured report.

## How providers are selected per run

Each run is executed with `options.providers = [providerId]`, which selects that
provider for channels that do not pin an explicit provider. The harness then
aggregates the resulting run's channels. Channels that hard-code a `provider` in
the pipeline spec are not overridden — design the pipeline without per-channel
provider pins if you want the harness to compare providers across all channels.

## Out of scope

- Automatic provider switching at runtime.
- Anything resembling a model marketplace.
