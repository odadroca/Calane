# Synthesis variants

Synthesis in Calane is just a channel that consumes the prior channels' results
(`{{channel_results}}`). A **synthesis variant** is therefore a prompt template
plus an optional output schema — there is no new executor logic. This doc
catalogs the variants shipped in `examples/`.

## The `variant` field

A pipeline's synthesis channel may carry an optional `variant` naming the method
it implements:

```yaml
synthesis:
  id: synthesis
  variant: weighted   # consensus | steelman | adversarial | weighted
  executionMode: direct_provider
  prompt: prompts/synthesis/weighted.md
  outputSchema: schemas/synthesis/weighted.synthesis.schema.json
```

`variant` is **descriptive metadata only**. The executor runs no variant-specific
branch — the variant is realized entirely by the prompt template (and schema) the
author selects. The field lets callers, bundles, and telemetry report which
synthesis method a run used. `consensus` is the conceptual default (the MVP
synthesis behavior). It is authored in TypeBox (`SynthesisVariant` /
`SynthesisSpec` in `PipelineSpec.ts`); an unknown value is rejected by
`validate-pipeline`.

## Built-in variants

Each variant ships a prompt in `examples/prompts/synthesis/` and a schema in
`examples/schemas/synthesis/`, with a matching example pipeline
`examples/pipelines/synthesis_<variant>.pipeline.yaml`.

### consensus (default)

Foregrounds where the channels agree; down-weights idiosyncratic claims. Output:
`{ summary, recommendations: [{ action, rationale }], agreements?, openQuestions? }`.

### steelman

Combines the strongest, most defensible form of each channel's position. Output
adds an optional `strongest_case`.

### adversarial

Stress-tests each recommendation against its strongest objection before keeping
it. Each recommendation additionally requires a `withstood_objection`.

### weighted

Weights each channel's contribution by stated confidence and provider reliability.
Each recommendation additionally requires a numeric `weight` in [0, 1].

### surviving_position

A fifth, conceptually-related variant documented below — it adjudicates which
positions survive an adversarial pass rather than emitting recommendations.

## surviving_position

- Prompt: `prompts/synthesis_surviving_position.md`
- Schema: `schemas/surviving_position.synthesis.schema.json`
- Pipeline: `pipelines/surviving_position.pipeline.yaml`
  (`steelman` + `dissent` + `red_team` → surviving_position synthesis)

Identifies which positions survive an adversarial pass. Output shape:

```jsonc
{
  "positions": [
    {
      "claim": "...",
      "support": "...",
      "dissent_responses": ["how the objection was answered", "..."],
      "survives": true,
      "confidence": 0.7
    }
  ],
  "summary": "optional top-level summary"
}
```

A position with `survives: false` is recorded with its `dissent_responses` so the
trace shows *why* it was dropped, not merely that it was.
