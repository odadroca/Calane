# Concurrency

A pipeline run executes its non-synthesis channels concurrently. Concurrency is
bounded by a structured policy that replaces the blanket `maxConcurrency` run
option (which remains as a fallback global cap).

## Configuration

```yaml
id: my-pipeline
version: 0.1.0
concurrency:
  global: 8 # max total in-flight channels across the whole run
  perProvider: # max in-flight channels per provider id
    openai: 4
    anthropic: 2
providers:
  - id: openai
    type: openai-compatible
  - id: anthropic
    type: anthropic
channels: [...]
```

- `global` caps total in-flight channels. When omitted, the run option
  `maxConcurrency` is used (default 4).
- `perProvider` caps in-flight channels per provider id. A channel runs only
  when both the global limiter and (if configured) its provider limiter have
  capacity.

Implementation uses one `p-limit` limiter for the global cap plus one `p-limit`
limiter per provider id, composed so a channel acquires the global slot first,
then the provider slot.

> Per-provider caps apply only on the concurrent execution path. When
> enforcement policies (e.g. CostBudgetPolicy) are registered, channels in a
> depth run sequentially (see `docs/policy.md`), so concurrency is implicitly 1.

## Rate-limit (HTTP 429) backoff

Both the OpenAI-compatible and Anthropic providers automatically back off and
retry on HTTP 429:

- The `Retry-After` response header is honored where present (seconds or HTTP
  date).
- When absent, an exponential default backoff is used
  (`defaultBackoffMs * 2^attempt`, default base 1000ms).
- Retries are capped at `maxRateLimitRetries` (default 3); after that the
  provider surfaces a `provider_error 429`, which the channel's `retry` config
  (see `docs/retry-and-repair.md`) may further retry.

These knobs are constructor options on each provider
(`maxRateLimitRetries`, `defaultBackoffMs`, and an injectable `sleep` for tests).

## Out of scope

- Distributed concurrency across multiple kernel instances.
- Per-API-key budget enforcement (a gateway concern).
