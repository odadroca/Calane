import type { TelemetryEvent, TelemetrySinkInterface } from "@llm-pipe/core";
import { type Span, SpanStatusCode, type Tracer, context, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export interface OtelTelemetrySinkOptions {
  /** Service name reported on the resource. Default "llm-pipeline-kernel". */
  serviceName?: string;
  /**
   * OTLP/HTTP traces endpoint. Defaults to
   * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` env
   * vars. When neither is set and no `exporter` is injected, no exporter is
   * attached (spans are still created in-process; useful for tests that read
   * spans from an injected processor/exporter).
   */
  endpoint?: string;
  /** Inject a span exporter (e.g. an in-memory exporter for tests). */
  exporter?: SpanExporter;
  /** Inject a provider (advanced/testing). Overrides serviceName/endpoint/exporter. */
  provider?: BasicTracerProvider;
}

/**
 * OpenTelemetry telemetry sink implementing TelemetrySinkInterface. NOT a
 * Langfuse adapter — OTel is vendor-neutral (a Langfuse backend can consume OTLP
 * if desired).
 *
 * Span hierarchy per run:
 *   run span  (opened on startTrace, closed on endTrace)
 *     └─ channel span  (one per `channel.end` event)
 *          └─ provider_call span (nested; one provider call per channel)
 *
 * The run span's trace id is returned from startTrace so the executor can put it
 * in RunResult.telemetry.traceId. Every method is wrapped so a telemetry failure
 * never propagates (per the observational-plugin policy).
 */
export class OtelTelemetrySink implements TelemetrySinkInterface {
  readonly name = "otel";
  private readonly provider: BasicTracerProvider;
  private readonly tracer: Tracer;
  private readonly runSpans = new Map<string, Span>();

  constructor(options: OtelTelemetrySinkOptions = {}) {
    if (options.provider) {
      this.provider = options.provider;
    } else {
      const endpoint =
        options.endpoint ??
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      const exporter =
        options.exporter ?? (endpoint ? new OTLPTraceExporter({ url: endpoint }) : undefined);
      this.provider = new BasicTracerProvider({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: options.serviceName ?? "llm-pipeline-kernel",
        }),
        spanProcessors: exporter ? [new SimpleSpanProcessor(exporter)] : [],
      });
    }
    this.tracer = this.provider.getTracer("llm-pipeline-kernel");
  }

  async startTrace(runId: string): Promise<string | null> {
    try {
      const span = this.tracer.startSpan("pipeline.run", { attributes: { "run.id": runId } });
      this.runSpans.set(runId, span);
      return span.spanContext().traceId;
    } catch {
      return null;
    }
  }

  async emit(event: TelemetryEvent): Promise<void> {
    try {
      const runSpan = this.runSpans.get(event.runId);
      if (event.type === "run.start" && runSpan) {
        runSpan.setAttributes(toAttributes(event.attributes));
        return;
      }
      if (event.type === "channel.end") {
        this.recordChannel(runSpan, event);
      }
      if (event.type === "policy.decision" && runSpan) {
        // Surface the enforcement-policy decision on the run span so it is
        // visible alongside the run (attribute key `policy.decision`).
        runSpan.addEvent("policy.decision", toAttributes(event.attributes));
        runSpan.setAttribute(
          "policy.decision",
          String(event.attributes?.["policy.decision"] ?? ""),
        );
      }
    } catch {
      // observational — never throw
    }
  }

  async endTrace(runId: string): Promise<void> {
    try {
      const span = this.runSpans.get(runId);
      if (span) {
        span.end();
        this.runSpans.delete(runId);
      }
    } catch {
      // observational — never throw
    }
  }

  /** Flush and shut down the provider (call once at process end). */
  async shutdown(): Promise<void> {
    try {
      await this.provider.forceFlush();
      await this.provider.shutdown();
    } catch {
      // observational
    }
  }

  private recordChannel(runSpan: Span | undefined, event: TelemetryEvent): void {
    const attrs = toAttributes(event.attributes);
    const channelName = String(event.attributes?.["channel.id"] ?? event.channelId ?? "channel");
    const latencyMs = Number(event.attributes?.latency_ms ?? 0);

    // Parent the channel span under the run span when one exists.
    const parentCtx = runSpan ? trace.setSpan(context.active(), runSpan) : context.active();

    const channelSpan = this.tracer.startSpan(
      `channel.${channelName}`,
      { attributes: attrs },
      parentCtx,
    );

    // Nested provider-call span (one provider call per channel in this phase).
    const providerCtx = trace.setSpan(parentCtx, channelSpan);
    const providerSpan = this.tracer.startSpan(
      "provider.call",
      {
        attributes: {
          "provider.id": String(event.attributes?.["provider.id"] ?? ""),
          model: stringOrUndef(event.attributes?.model),
          "usage.input_tokens": numberOrUndef(event.attributes?.["usage.input_tokens"]),
          "usage.output_tokens": numberOrUndef(event.attributes?.["usage.output_tokens"]),
          "usage.cost_usd": numberOrUndef(event.attributes?.["usage.cost_usd"]),
        },
      },
      providerCtx,
    );

    const status = String(event.attributes?.["validation.status"] ?? "");
    if (status && status !== "ok") {
      channelSpan.setStatus({ code: SpanStatusCode.ERROR, message: status });
      providerSpan.setStatus({ code: SpanStatusCode.ERROR, message: status });
    }
    providerSpan.end();
    channelSpan.end();
    // touch latency so it is reflected even if a backend ignores duration
    channelSpan.setAttribute("latency_ms", latencyMs);
  }
}

function toAttributes(
  attributes: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!attributes) return out;
  for (const [k, v] of Object.entries(attributes)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      out[k] = JSON.stringify(v);
    }
  }
  return out;
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
