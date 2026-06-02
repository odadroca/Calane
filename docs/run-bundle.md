# Run bundles

Every run is exportable as a reproducible bundle directory. The `RunBundleExporter`
(`packages/core/src/bundle/RunBundleExporter.ts`) writes:

```
run_bundle/<runId>/
  manifest.json            run + source metadata, per-channel status summary
  input.md                 the analysis input
  pipeline.resolved.json   the resolved pipeline (when supplied to the exporter)
  execution_plan.json      providers, recursion config, channel + synthesis ids
  channel_results/
    <channel>.<provider>.json    full ChannelResult per channel + synthesis
  raw_outputs/
    <channel>.<provider>.txt     raw model output (ALWAYS preserved)
  validation/
    <channel>.validation.json    { status, schemaValid, errors }
  final.md                 human-readable synthesis + channel summary
```

## Reproducibility & traceability

`manifest.json` carries the `source` block from the `RunResult`:

```json
{
  "source": {
    "registry": "filesystem",
    "ref": "/abs/path/examples/pipelines/swot_recursive.pipeline.yaml",
    "commitSha": null,
    "pipelineHash": "sha256:...",
    "promptHashes": { "strengths": "sha256:...", "...": "..." },
    "schemaHashes": { "strengths": "sha256:...", "synthesis": "sha256:..." }
  }
}
```

- `pipelineHash` is the sha256 of the **canonical** JSON of the resolved spec.
- `promptHashes` hash the **prompt template text** per channel.
- `schemaHashes` hash the **canonical JSON Schema** per channel.
- When resolved via the Git registry, `commitSha` records the working-tree HEAD.

All hashes are computed with `node:crypto` over canonical representations
(`packages/core/src/util/hash.ts`).

## Security

- Provider credentials are **never** written into a bundle.
- With `--redacted` / `redacted: true`, obvious secret-looking tokens
  (`sk-...`, JWT-shaped strings, `api_key: "..."`) are scrubbed from raw outputs.

## Producing a bundle

```bash
# during a run
node packages/cli/dist/index.js run swot_recursive examples/inputs/sample-topic.md \
  --providers mock --export run_bundles

# from a stored run
node packages/cli/dist/index.js export-run <run-id> --out run_bundles --redacted
```
