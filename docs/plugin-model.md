# Plugin model

Plugins are split into **functional** (can change execution / outputs) and
**observational** (watch only). Mutation points are explicit; every plugin's
identity is recorded in run metadata.

## Functional plugins

These participate in producing the `RunResult` and may fail the run when they
fail (they are execution-critical):

| Plugin | Interface | MVP implementations |
| --- | --- | --- |
| Prompt/pipeline registry | `PromptRegistryInterface` | filesystem, git |
| Provider adapter | `ProviderAdapterInterface` | mock, openai-compatible, delegated-agent |
| Result store | `ResultStoreInterface` | filesystem |
| Validator | `JsonSchemaValidator` | Ajv (built-in) |
| Policy | `PolicyPluginInterface` | `DefaultRecursionPolicy` |

## Observational plugins

These watch a run and **must not fail it by default**:

| Plugin | Interface | MVP implementations |
| --- | --- | --- |
| Telemetry sink | `TelemetrySinkInterface` | `NoopTelemetrySink` |
| Exporter | `ExporterInterface` | `RunBundleExporter` |
| Logger | pino (in the REST server) | structured operational logs |
| Notification sink | (planned) | — |

## Rules

1. **Do not allow arbitrary plugins to mutate everything.** Functional plugins
   have narrow, typed contracts; observational plugins receive read-only views.
2. **Mutation points are explicit.** The executor decides what each plugin can
   influence; plugins do not reach into the `RunResult` arbitrarily.
3. **Every plugin output is recorded in run metadata.** Registry name + ref +
   hashes, provider type/model, validation reports, telemetry trace id.
4. **Telemetry vs. logs.** pino structured logs are an operational log stream,
   **not** a telemetry sink. Telemetry is the pluggable `TelemetrySinkInterface`
   (no-op first; Langfuse/OpenTelemetry adapters later). Telemetry failures are
   swallowed so they cannot fail a run.

## Registering plugins

The kernel wiring (e.g. `packages/cli/src/kernel.ts`) builds a `ProviderRegistry`
and passes a registry, store, and optional telemetry/policy into the
`PipelineExecutor`:

```ts
const providers = new ProviderRegistry()
  .register(new MockProvider())
  .register(new OpenAICompatibleProvider())
  .register(new DelegatedAgentProvider());

const executor = new PipelineExecutor({ registry, providers, store /*, telemetry, policy */ });
```
