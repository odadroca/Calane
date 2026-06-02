import { type Static, Type } from "@sinclair/typebox";

export const ExecutionMode = Type.Union(
  [Type.Literal("direct_provider"), Type.Literal("delegated_agent")],
  { $id: "ExecutionMode" },
);
export type ExecutionMode = Static<typeof ExecutionMode>;

/** Conditions under which a transient retry is attempted. */
export const RetryCondition = Type.Union(
  [Type.Literal("provider_error"), Type.Literal("timeout")],
  { $id: "RetryCondition" },
);
export type RetryCondition = Static<typeof RetryCondition>;

/** Conditions under which a schema-repair attempt is made. */
export const RepairCondition = Type.Union(
  [Type.Literal("schema_error"), Type.Literal("invalid_json")],
  { $id: "RepairCondition" },
);
export type RepairCondition = Static<typeof RepairCondition>;

/**
 * Retry-on-transient-error config. `attempts` is the number of ADDITIONAL tries
 * after the first call. Backoff between tries is exponential:
 * `backoffMs * 2^(retryIndex)`.
 */
export const RetryConfig = Type.Object(
  {
    attempts: Type.Number({ minimum: 0 }),
    backoffMs: Type.Optional(Type.Number({ minimum: 0 })),
    on: Type.Optional(Type.Array(RetryCondition)),
  },
  { $id: "RetryConfig", additionalProperties: false },
);
export type RetryConfig = Static<typeof RetryConfig>;

/**
 * Repair-on-schema-failure config. `attempts` is the number of repair prompts
 * issued after an invalid result. `promptTemplate`, when provided, overrides the
 * default repair prompt; it may reference `{{schema}}` and `{{output}}`.
 */
export const RepairConfig = Type.Object(
  {
    attempts: Type.Number({ minimum: 0 }),
    on: Type.Optional(Type.Array(RepairCondition)),
    promptTemplate: Type.Optional(Type.String()),
  },
  { $id: "RepairConfig", additionalProperties: false },
);
export type RepairConfig = Static<typeof RepairConfig>;

/**
 * A single analysis channel. Each channel renders a prompt, runs it against a
 * provider (or a delegated agent), and optionally validates the result against
 * a JSON Schema file referenced relative to the pipeline registry root.
 */
export const ChannelSpec = Type.Object(
  {
    id: Type.String(),
    name: Type.Optional(Type.String()),
    executionMode: ExecutionMode,
    /** Path to the prompt template, relative to the registry root. */
    prompt: Type.String(),
    /** Path to a JSON Schema file on disk used to validate structured output. */
    outputSchema: Type.Optional(Type.String()),
    /** Provider id (from PipelineSpec.providers) overriding the run default. */
    provider: Type.Optional(Type.String()),
    /**
     * Ids of channels this channel depends on. When any channel in a pipeline
     * declares `dependsOn`, the executor runs channels in topological order and
     * exposes each upstream channel's output to this channel's prompt as
     * `{{channel_results.<id>.parsed}}` / `{{channel_results.<id>.raw}}`.
     * Pipelines that omit `dependsOn` everywhere execute flat, in declared order
     * (unchanged behavior). A cyclic graph is rejected by `validate-pipeline`.
     */
    dependsOn: Type.Optional(Type.Array(Type.String())),
    /**
     * Number of JSON-repair attempts permitted on invalid output (default 0).
     * Retained for backward compatibility; `repair.attempts` takes precedence
     * when both are present.
     */
    repairAttempts: Type.Optional(Type.Number({ minimum: 0 })),
    /** Retry-on-transient-error config; falls back to the pipeline default. */
    retry: Type.Optional(RetryConfig),
    /** Repair-on-schema-failure config; falls back to the pipeline default. */
    repair: Type.Optional(RepairConfig),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { $id: "ChannelSpec", additionalProperties: false },
);

export type ChannelSpec = Static<typeof ChannelSpec>;
