# Channel library

Calane ships a small library of reusable **channel templates** in `examples/`.
A channel template is nothing more than a prompt (`examples/prompts/*.md`) plus
an output schema (`examples/schemas/*.channel.schema.json`). There is **no new
abstraction**: a channel template is an ordinary `ChannelSpec` you reference from
a pipeline's `channels` list, exactly like the SWOT channels.

This doc catalogs the templates available out of the box.

## Analytical channels

### SWOT channels (`strengths`, `weaknesses`, `opportunities`, `threats`)

- Prompts: `prompts/swot/{strengths,weaknesses,opportunities,threats}.md`
- Schema: `schemas/swot.channel.schema.json`
- Output: `{ dimension, claims: [{ statement, confidence, evidence? }] }`

The four classic SWOT dimensions. Each emits a non-empty list of claims with a
numeric confidence.

### `dissent`

- Prompt: `prompts/dissent.md`
- Schema: `schemas/dissent.channel.schema.json`
- Output: `{ objections: [{ target, challenge, severity, rebuttal_difficulty? }] }`

A disciplined dissenting pass. Reads prior channel results (`{{channel_results}}`)
and surfaces the strongest objections to them. Place it **after** the channels it
should challenge and **before** synthesis.

### `red_team`

- Prompt: `prompts/red_team.md`
- Schema: `schemas/red_team.channel.schema.json`
- Output: `{ attacks: [{ vector, impact, likelihood, mitigation? }] }`

An adversarial pass that treats the prior analysis as an opponent's plan and maps
its attack surface (assumptions, failure modes, exploits).

### `steelman`

- Prompt: `prompts/steelman.md`
- Schema: `schemas/steelman.channel.schema.json`
- Output: `{ positions: [{ claim, best_support, confidence }] }`

Constructs the strongest defensible version of the case. Useful as the first
channel in a steelman → red_team → synthesis pipeline.

## Example pipelines using these channels

- `pipelines/swot_recursive_dissent.pipeline.yaml` — SWOT plus a `dissent`
  channel between `threats` and `synthesis`.
- `pipelines/steelman_redteam.pipeline.yaml` — `steelman` then `red_team` then
  `synthesis`.

## Note on data flow

Channels in a flat pipeline run in declared order. The `{{channel_results}}`
template variable is populated for the synthesis channel from the channels that
ran before it. To make an intermediate channel (such as `dissent`) consume
specific upstream outputs directly, declare a dependency graph — see
[`dag.md`](./dag.md), which adds `dependsOn` and the
`{{channel_results.<id>.parsed}}` / `{{channel_results.<id>.raw}}` variables.
