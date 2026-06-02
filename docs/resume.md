# Partial-run recovery (resume)

A run that fails or partially completes can be resumed from its last-good
channel. Resume re-executes only the channels that did not complete
successfully and carries forward the completed ones unchanged.

## What resume does

1. Loads the prior run by id from the result store.
2. Re-resolves the pipeline (`prior.pipelineId`).
3. **Verifies hashes**: the prior run's `pipelineHash` and every recorded
   `promptHash`/`schemaHash` must match the current pipeline definition. If any
   differ, resume is refused (see below).
4. Carries forward channels whose status was `ok` (their `ChannelResult` is
   spliced into the new run unchanged).
5. Re-executes the remaining channels (and synthesis) normally.
6. Produces a new `RunResult` with a fresh `runId` and `resumedFrom` set to the
   prior run's id.

Only depth 1 carries forward completed channels; recursion past depth 1 runs
fresh as usual.

## Interfaces

Resume is intentionally **not** a separate external tool — the MCP/openai
surface stays at exactly 8 tools. It is exposed three ways:

- **CLI**: `llm-pipe resume <run-id>` (optionally `--export [dir]`).
- **REST**: `POST /runs/:runId/resume` → `201` with the resumed `RunResult`.
- **MCP / openai.json**: `run_pipeline` with `options.resumeFromRunId` set. When
  present, `pipelineId`/`input` are taken from the prior run; completed channels
  are carried forward. (REST `POST /runs` with `options.resumeFromRunId` behaves
  identically.)

## Hash-mismatch behaviour

If the pipeline definition changed since the prior run (different pipeline hash,
or a changed/removed prompt or schema for any recorded channel), resume is
**refused** rather than producing an inconsistent run. The error is structured:

```json
{
  "error": "refusing to resume <id>: pipeline definition changed",
  "code": "hash_mismatch",
  "mismatches": ["promptHash[c3]: prior=sha256:… current=sha256:…"]
}
```

- CLI: prints the structured error to stderr and exits non-zero.
- REST: `409 Conflict` with the structured body (`404` when the prior run does
  not exist, `code: run_not_found`).

This preserves the core guarantee: a resumed run is reproducible against the
exact pipeline/prompt/schema the original run used. Pipeline definition changes
during resume are refused, not silently handled.
