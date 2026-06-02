# Architecture

`llm-pipeline-kernel` is a library-first, CLI-first execution kernel. Every
gateway (CLI, REST, MCP, openai.json) is a thin shell over the same core.

## Flow

```
Caller
  -> Gateway: CLI | REST | MCP | openai.json
  -> PipelineExecutor.run(RunRequest)
       1. PromptRegistry.resolvePipeline()      (filesystem | git; records ref + hash + commitSha)
       2. buildExecutionPlan()                  (explicit channels, providers, depth, synthesis)
       3. for depth in 1..maxDepth:
            - run channels concurrently (p-limit, maxConcurrency)
            - run synthesis channel (consumes channel results)
            - PolicyPlugin.decideRecursion()    (bounded; never model-decided)
       4. aggregate validation + status
       5. ResultStore.saveRun()
  -> RunBundleExporter.export()                 (reproducible bundle)
```

Each channel (`ChannelExecutor.executeChannel`):

```
render prompt (PromptRenderer)
  -> ProviderAdapter.execute()                  (direct_provider | delegated_agent)
  -> JsonSchemaValidator.parseAndValidate()     (Ajv)
  -> ResultStore.saveRawOutput()                (raw ALWAYS preserved)
  -> ChannelResult { status, schemaValid, usage, latency, ... }
```

## Core abstractions

| Abstraction | File |
| --- | --- |
| `PipelineSpec`, `ChannelSpec`, `ProviderSpec` | `core/src/specs/*` (TypeBox) |
| `RunRequest`, `RunResult`, `ChannelResult` | `core/src/specs/*` (TypeBox) |
| `PipelineExecutor` | `core/src/executor/PipelineExecutor.ts` |
| `ExecutionPlan` | `core/src/executor/ExecutionPlan.ts` |
| `ChannelExecutor` | `core/src/executor/ChannelExecutor.ts` |
| `RecursionPolicy` | `core/src/executor/RecursionPolicy.ts` |
| `PromptRenderer` | `core/src/rendering/PromptRenderer.ts` |
| `JsonSchemaValidator` | `core/src/validation/JsonSchemaValidator.ts` |
| Plugin interfaces | `core/src/plugins/*` |
| `RunBundleExporter` | `core/src/bundle/RunBundleExporter.ts` |

## Execution model invariants

- **No hidden recursion.** Channels, providers, depth, and synthesis are all
  materialized in the `ExecutionPlan` up front.
- **No model-decided loop count.** Recursion is governed by `RecursionPolicy`
  with a required `maxDepth` and optional `maxCostUsd` / `maxRuntimeMs`.
- **Raw output is always stored**, even when JSON is invalid or schema-invalid.
- **Synthesis is just another channel** that consumes prior channel results.

## Channel execution modes

- `direct_provider` — render prompt, call a `ProviderAdapter`, validate, store.
- `delegated_agent` — build an instruction bundle (carrying `runId` +
  `channelId`), hand it to an external agent/LLM/tool surface, receive a
  structured result through MCP or an OpenAI-style JSON callback, validate, store.
  The MVP ships a resolver-based placeholder; real transports (and callback
  signing) are future work.

## Recursion & carry-forward

`PipelineSpec.recursion` carries `enabled`, `maxDepth`, optional `maxCostUsd` /
`maxRuntimeMs`, and a `carryForwardStrategy`:
`synthesis_only`, `full_context`, `dissent_only`, `unresolved_questions_only`,
`highest_confidence_claims_only`. The default executor carries the previous
synthesis forward via the `{{previous_synthesis}}` template variable.

## Latency / cost controls

`maxDepth`, `timeoutMs` per provider call, `maxConcurrency` (p-limit),
cancellation via `AbortSignal`. Latency is recorded per channel; token usage and
cost are recorded when the provider returns them. Full cost governance is out of
scope for the MVP.
