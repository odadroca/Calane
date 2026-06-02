# Retry and repair

A channel can recover from two distinct failure classes:

- **Transient errors** (`provider_error`, `timeout`) — the provider call itself
  failed. Handled by **retry** with exponential backoff.
- **Schema failures** (`schema_error`, `invalid_json`) — the call returned, but
  the output did not validate. Handled by **repair**: re-prompting the model
  with the schema and the bad output.

Both are configured per channel, or as a pipeline-level default that channels
inherit. Channel-level config overrides the pipeline default.

## Configuration

```yaml
id: my-pipeline
version: 0.1.0
# Pipeline-wide defaults; any channel may override.
defaults:
  retry:
    attempts: 3 # additional tries after the first call
    backoffMs: 200 # base backoff; exponential per retry
    on: [provider_error, timeout]
  repair:
    attempts: 2 # repair prompts issued after an invalid result
    on: [schema_error, invalid_json]
providers:
  - id: main
    type: openai-compatible
channels:
  - id: strengths
    executionMode: direct_provider
    prompt: prompts/strengths.md
    outputSchema: schemas/list.schema.json
    # Channel-level override of the default:
    retry:
      attempts: 5
      backoffMs: 100
      on: [timeout]
```

### `retry`

| field       | meaning                                                          |
| ----------- | ---------------------------------------------------------------- |
| `attempts`  | number of ADDITIONAL tries after the first call.                 |
| `backoffMs` | base backoff (default 200). Sleep before retry _i_ is `backoffMs * 2^(i-1)` (i.e. 200, 400, 800, …). |
| `on`        | conditions that trigger a retry. Default `[provider_error, timeout]`. |

Only the listed conditions are retried. A `timeout` (AbortError) is retried only
when `timeout` is in `on`; a thrown provider error is retried only when
`provider_error` is in `on`. Once retries are exhausted, the channel reports
`error` or `timeout`.

### `repair`

| field            | meaning                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `attempts`       | number of repair prompts issued after an invalid result.         |
| `on`             | conditions that trigger a repair. Default `[schema_error, invalid_json]`. |
| `promptTemplate` | optional override of the repair prompt. May reference `{{original}}`, `{{schema}}`, and `{{output}}`. |

When `repair` is omitted, the legacy `channel.repairAttempts` count is used as
the repair attempt budget (back-compat). When both are present, `repair.attempts`
takes precedence.

The default repair prompt restates the original prompt, the required JSON
Schema, and the previous invalid output, and asks for a corrected JSON object.

## Attempt metadata

Every attempt is recorded on `ChannelResult.metadata.attempts` as an array of:

```ts
{ attempt: number; kind: "initial" | "retry" | "repair"; status: ChannelStatus; backoffMs?: number }
```

This lets a run bundle show exactly how many tries (and repairs) each channel
took and the backoff applied. `repairAttempted` remains set when any repair was
issued.

## Ordering

For a single channel the lifecycle is: the transient-retry loop wraps the
call-and-repair logic. Each retry performs a fresh provider call and then runs
the repair loop on the result. Retries address provider/timeout failures; repair
addresses validation failures.
