# Telemetry

Telemetry is an **observational** plugin: a telemetry failure must never fail a
run. The kernel's `TelemetrySinkInterface` (`@llm-pipe/core`) is intentionally
small — `startTrace(runId)`, `emit(event)`, `endTrace(runId)` — and the default
sink is a no-op. This is distinct from operational logs (pino); telemetry is for
traces/spans, not log streams.

The kernel ships one sink: **OpenTelemetry** (`@llm-pipe/telemetry-otel`). OTel is
vendor-neutral; a Langfuse (or any OTLP) backend can consume the exported spans.
This is **not** a Langfuse adapter — that would sit on the boundary of the
"no Langfuse clone" non-goal.

## What the executor emits

The `PipelineExecutor` emits structured telemetry events (it does not itself know
about spans):

| Event `type` | When | Key attributes |
|---|---|---|
| `run.start` | after the trace opens | `pipeline.id`, `pipeline.hash` |
| `channel.end` | after each channel (and synthesis) completes | the full channel/provider attribute set below |
| `run.end` | before the trace closes | `status`, `validation.valid` |

`channel.end` carries: `pipeline.id`, `pipeline.hash`, `channel.id`,
`provider.id`, `model`, `usage.input_tokens`, `usage.output_tokens`,
`usage.cost_usd`, `latency_ms`, `validation.status`, `channel.is_synthesis`.

## The OpenTelemetry sink

`OtelTelemetrySink` builds this span hierarchy per run:

```
pipeline.run                (opened on startTrace, closed on endTrace)
  └─ channel.<id>           (one per channel.end)
       └─ provider.call     (nested; one provider call per channel)
```

- **Trace ID** — the run span's trace id is returned from `startTrace` and the
  executor stores it in `RunResult.telemetry.traceId`.
- **Span attributes** — the channel span carries the attribute set above; the
  provider-call span carries `provider.id`, `model`, and the usage attributes.
  Non-`ok` `validation.status` marks the span status as `ERROR`.
- **Failure isolation** — every sink method is wrapped; a telemetry error never
  propagates into the run.

### Configuration (env)

The export endpoint is read from the environment:

- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, else
- `OTEL_EXPORTER_OTLP_ENDPOINT`

When neither is set (and no exporter is injected), spans are still created
in-process but not exported — useful for tests, which inject an in-memory
exporter. You can also pass `serviceName`, an explicit `endpoint`, an injected
`exporter`, or a fully-built `provider` to the constructor.

### Usage

```ts
import { OtelTelemetrySink } from "@llm-pipe/telemetry-otel";
import { PipelineExecutor } from "@llm-pipe/core";

const telemetry = new OtelTelemetrySink({ serviceName: "calane" });
const executor = new PipelineExecutor({ registry, providers, store, telemetry });
// ... run pipelines ...
await telemetry.shutdown(); // flush + shut down at process end
```

### Testing

The integration test wires the sink into a real `PipelineExecutor` run (mock
provider) with an `InMemorySpanExporter` and asserts the `run > channel >
provider_call` hierarchy, the trace id round-trip, and the required span
attributes — no external collector required.
