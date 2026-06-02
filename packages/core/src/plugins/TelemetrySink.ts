/**
 * TelemetrySinkInterface — an OBSERVATIONAL plugin. Telemetry failures must not
 * fail the run by default. This is distinct from pino structured logs, which
 * are a separate operational log stream, not a telemetry sink.
 */
export interface TelemetryEvent {
  runId: string;
  channelId?: string;
  type: string;
  attributes?: Record<string, unknown>;
  timestamp: string;
}

export interface TelemetrySinkInterface {
  readonly name: string;
  /** Optional trace id to attach to the run; null when unsupported. */
  startTrace(runId: string): Promise<string | null>;
  emit(event: TelemetryEvent): Promise<void>;
  endTrace(runId: string): Promise<void>;
}

/**
 * Canonical telemetry event `type` strings the executor emits. A span-building
 * sink (e.g. the OpenTelemetry sink) interprets these to construct the span
 * hierarchy: a run span (from startTrace/endTrace), a channel span per
 * `channel.end`, and a nested provider-call span. The base
 * {@link TelemetrySinkInterface} shape is unchanged — these are just the
 * conventional `type` values and the attribute keys carried in
 * {@link TelemetryEvent.attributes}.
 */
export const TelemetryEventType = {
  RunStart: "run.start",
  DepthStart: "depth.start",
  ChannelEnd: "channel.end",
  RunEnd: "run.end",
  /** Emitted when an enforcement policy returns a decision at a hook point. */
  PolicyDecision: "policy.decision",
} as const;

/** Attribute keys for a `channel.end` event, mirrored onto channel/provider spans. */
export interface ChannelSpanAttributes {
  "pipeline.id": string;
  "pipeline.hash": string;
  "channel.id": string;
  "provider.id": string;
  model: string | null;
  "usage.input_tokens": number | null;
  "usage.output_tokens": number | null;
  "usage.cost_usd": number | null;
  latency_ms: number;
  "validation.status": string;
  /** True when this channel was the synthesis channel. */
  "channel.is_synthesis": boolean;
}

/** Default no-op sink. Never throws, never fails the run. */
export class NoopTelemetrySink implements TelemetrySinkInterface {
  readonly name = "noop";
  async startTrace(): Promise<string | null> {
    return null;
  }
  async emit(): Promise<void> {}
  async endTrace(): Promise<void> {}
}
