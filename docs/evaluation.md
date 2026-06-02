# Evaluation pipelines

**This is a pattern, not a feature.** Calane adds no evaluation abstraction, no
"evaluator" plugin, and no new tool. An evaluation pipeline is an ordinary
pipeline whose *input* happens to be another pipeline's run output and whose
*output* happens to be a structured score. Everything it needs already exists:
channels, prompts, JSON-Schema-validated output, the result store, and run
bundles.

## The pattern

1. Run a pipeline (e.g. `swot_recursive`) and get a `RunResult` / run bundle.
2. Feed that run's JSON (from the result store, or its exported bundle) as the
   `input` string to an evaluation pipeline.
3. The evaluation pipeline's prompt reads the prior run from `{{input}}` and emits
   a dimension-scored evaluation validated against a JSON Schema.

```
swot_recursive run  ──(run JSON as input)──▶  swot_eval pipeline  ──▶  evaluation
```

## Example

- Pipeline: `examples/pipelines/eval/swot_eval.pipeline.yaml`
- Prompt: `examples/prompts/eval/swot_eval.md`
- Schema: `examples/schemas/eval/evaluation.schema.json`

The `swot_eval` pipeline scores a SWOT run on five dimensions — completeness,
coherence, evidence quality, schema validity, and dissent depth — and an
`overall` score. Output shape:

```jsonc
{
  "dimensions": [
    { "name": "completeness", "score": 0.9, "rationale": "..." }
  ],
  "overall": 0.7
}
```

Because the evaluation is itself a normal run, it is versioned, hash-traceable,
schema-validated, stored, and exportable as a bundle — the same guarantees as any
other Calane run. You can evaluate the evaluation if you want to; it is pipelines
all the way down.

## A note on pipeline discovery

The filesystem registry discovers pipelines at the top level of
`<root>/pipelines/`. The example eval pipeline lives in a nested
`pipelines/eval/` directory for organization; to run it by id with the default
filesystem registry, either keep eval pipelines at the top level of `pipelines/`
or point a registry at the `eval/` directory. The pipeline file itself is an
ordinary, unmodified pipeline spec.

## Out of scope

- Cross-run aggregation / leaderboards (later phase).
- Any dashboard or UI for evaluation results.
- Any new evaluation-specific kernel abstraction.
