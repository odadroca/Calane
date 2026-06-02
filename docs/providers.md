# Providers

A provider adapter conforms to `ProviderAdapterInterface` from `@llm-pipe/core`:
it takes a `ProviderRequest` (rendered prompt, optional output JSON Schema, the
`ProviderSpec`) and returns a `ProviderResponse` (raw output text, model, token
usage, optional refusal flag). Credentials are read from environment variables
named by `ProviderSpec.apiKeyEnv` and are never persisted.

The kernel ships these adapters:

| Adapter type | Package | Notes |
|---|---|---|
| `mock` | `@llm-pipe/provider-mock` | Deterministic, offline; synthesizes schema-conforming output. |
| `openai-compatible` | `@llm-pipe/provider-openai-compatible` | Any OpenAI `/chat/completions` endpoint. |
| `delegated-agent` | `@llm-pipe/provider-openai-compatible` | Hands an instruction bundle to an external agent. |
| `anthropic` | `@llm-pipe/provider-anthropic` | Anthropic `claude-` models via `@anthropic-ai/sdk`. |

## Anthropic (`@llm-pipe/provider-anthropic`)

`AnthropicProvider` (adapter type `anthropic`) calls the Anthropic Messages API
through the official `@anthropic-ai/sdk`.

### Configuration

```yaml
providers:
  - id: anthropic
    type: anthropic
    model: claude-opus-4-7      # passed through provider config
    apiKeyEnv: ANTHROPIC_API_KEY  # default; never persisted
    options:
      maxTokens: 2048           # optional, default 4096
      system: "Optional system prompt"
```

- **API key:** read from the env var named by `apiKeyEnv` (default
  `ANTHROPIC_API_KEY`). If unset, the adapter throws a clear error
  (`Missing API key: env var ANTHROPIC_API_KEY is not set`) — it never falls back
  to a live call without a key.
- **Model:** taken from `ProviderSpec.model`.

### Structured output via tool_use

When a channel declares an `outputSchema`, the adapter registers that JSON Schema
as a single Anthropic tool (`emit_structured_output`) and forces its use with
`tool_choice`. The model's `tool_use` content block carries the structured object;
the adapter serializes its `input` to JSON as the channel's raw output, which the
kernel then validates with Ajv. When no schema is declared, the model's text
content blocks are concatenated instead.

### Usage and cost

`ProviderResponse.usage` reports `inputTokens` and `outputTokens` from the API
response, and `costUsd` computed from a pricing table bundled in the package
(`pricing.ts`, USD per 1M tokens). The table is hardcoded with an override hook:
pass `new AnthropicProvider({ pricing })` to supply current numbers without a code
change. Unknown models yield `costUsd: null` (cost is never silently zero). The
pricing lookup matches the longest known model-id prefix, so dated snapshots
resolve to their base price.

### Example pipeline

`examples/pipelines/swot_anthropic.pipeline.yaml` runs the SWOT channels and
synthesis against `claude-` models. It requires `ANTHROPIC_API_KEY` to run live.

### Testing

The provider's integration test injects a fake client that replays recorded JSON
fixtures (`tests/fixtures/*.json`) — there are no live API calls in the test
suite. The adapter accepts an injected client via
`new AnthropicProvider({ client })`, which is the seam the fixtures use.
