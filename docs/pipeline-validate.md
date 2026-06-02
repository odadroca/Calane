# pipeline-validate

Structural validation answers one question: **is this pipeline well-formed and
are its references resolvable?** It is not runtime correctness (that is
`run_pipeline`) and it is not linting (prompt length, style, cost). Validation
never calls a provider.

## Checks performed

The `PipelineValidator` (`@llm-pipe/core`) runs these checks:

1. **`spec_schema`** — the definition conforms to the `PipelineSpec` TypeBox
   schema (the single source of truth). If this fails, the remaining checks are
   skipped because the shape cannot be trusted.
2. **`prompt_missing`** — every channel's `prompt` file resolves through the
   registry.
3. **`schema_missing`** — every channel's `outputSchema` file resolves and
   parses as a JSON Schema object.
4. **`provider_missing`** — every declared provider's `type` is registered in
   the provider plugin list.
5. **`cycle`** — no cycles in channel dependencies. Channels are flat in this
   phase, so the detector is a no-op; it is the seam for the Phase 4 dependency
   graph.

## Report shape

```json
{
  "valid": false,
  "pipelineId": "my_pipeline",
  "issues": [
    { "check": "prompt_missing", "message": "Channel \"analyze\" prompt not found: prompts/x.md (...)", "path": "/channels/analyze/prompt" }
  ]
}
```

`valid` is `true` only when `issues` is empty.

## CLI

```sh
llm-pipe validate-pipeline examples/pipelines/swot_recursive.pipeline.yaml
```

Exits `0` when valid, non-zero when invalid. The JSON report is printed to
stdout in both cases. The registry root used to resolve prompt/schema paths is
inferred from the file location (the parent of a `pipelines/` folder) and can be
overridden with `--registry <dir>`.

## REST

```
POST /pipelines/:pipelineId/validate
```

Returns `200` with the report (plus `pipelineHash`) for a resolvable pipeline,
including when the pipeline is structurally invalid (the report's `valid` field
carries that signal). Returns `404` when the pipeline id cannot be resolved.

## MCP

The `validate_pipeline` tool (one of the 8 coarse tools) returns the same report
for a pipeline id. No new tool is added — this fills in the existing tool.
