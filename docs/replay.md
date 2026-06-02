# Replay

Replay re-executes a run from its exported **bundle directory alone**, producing
a new, immutable run. It is part of Phase 5 (cross-run reasoning) and is a CLI +
core feature only — it does **not** add to the 8-tool MCP/openai surface.

## How it works

`Replayer.replay(bundlePath)` (in `@llm-pipe/core`,
`packages/core/src/replay/Replayer.ts`):

1. Reads `manifest.json` and `input.md` from the bundle directory.
2. Re-resolves the pipeline by `manifest.pipelineId` from the registry and
   recomputes the **current** `pipelineHash`, per-channel `promptHashes`, and
   per-channel `schemaHashes`.
3. Compares the recomputed hashes against the hashes recorded in the bundle
   manifest's `source` block.
4. **On any mismatch**, refuses with a `ReplayError` (`code: "hash_mismatch"`)
   listing exactly which hash differs (e.g.
   `pipelineHash: bundle=… current=…`). The pipeline definition has drifted
   since the original run, so a replay would not be reproducible.
5. **On a clean match**, executes the pipeline against the currently configured
   providers. The new run's `replayedFrom` is set to the original run id, and a
   diff between the original and the replay is produced via the S17 differ.

Hash verification uses the bundle's `manifest.json` (which carries
`source.pipelineHash`, `promptHashes`, `schemaHashes`) plus `input.md`. It does
not require `pipeline.resolved.json` to be populated.

## `RunResult.replayedFrom`

A replay run records the original run id in `replayedFrom`. This mirrors
`resumedFrom` (resume lineage) and keeps replay lineage traceable.

## CLI

```sh
llm-pipe replay <bundle-path> --providers mock
llm-pipe replay <bundle-path> --providers mock --format json
```

Default output is the markdown diff between original and replay; `--format json`
emits `{ replay, diff }`. On a hash mismatch or unreadable bundle the CLI prints
the structured error to stderr and exits non-zero.

## Out of scope

- Network-fetched replay (only local bundles for now).
- Bundle signing verification (a later phase).
