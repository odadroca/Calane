import { type Static, Type } from "@sinclair/typebox";

export const ChannelStatus = Type.Union(
  [
    Type.Literal("ok"),
    Type.Literal("invalid_json"),
    Type.Literal("schema_error"),
    Type.Literal("refused"),
    Type.Literal("timeout"),
    Type.Literal("error"),
  ],
  { $id: "ChannelStatus" },
);
export type ChannelStatus = Static<typeof ChannelStatus>;

export const Usage = Type.Object(
  {
    inputTokens: Type.Union([Type.Number(), Type.Null()]),
    outputTokens: Type.Union([Type.Number(), Type.Null()]),
    costUsd: Type.Union([Type.Number(), Type.Null()]),
  },
  { $id: "Usage", additionalProperties: false },
);
export type Usage = Static<typeof Usage>;

export const ChannelResult = Type.Object(
  {
    channelId: Type.String(),
    executionMode: Type.Union([Type.Literal("direct_provider"), Type.Literal("delegated_agent")]),
    provider: Type.String(),
    model: Type.Union([Type.String(), Type.Null()]),
    status: ChannelStatus,
    latencyMs: Type.Number(),
    usage: Usage,
    rawOutputRef: Type.Union([Type.String(), Type.Null()]),
    parsedOutput: Type.Unknown(),
    schemaValid: Type.Boolean(),
    validationErrors: Type.Array(Type.Unknown()),
    repairAttempted: Type.Optional(Type.Boolean()),
    metadata: Type.Record(Type.String(), Type.Unknown()),
  },
  { $id: "ChannelResult", additionalProperties: false },
);
export type ChannelResult = Static<typeof ChannelResult>;

export const PolicyDecision = Type.Object(
  {
    policyId: Type.String(),
    hook: Type.Union([Type.Literal("beforeChannel"), Type.Literal("afterChannel")]),
    channelId: Type.String(),
    decision: Type.String(),
    reason: Type.String(),
  },
  { $id: "PolicyDecision", additionalProperties: false },
);
export type PolicyDecision = Static<typeof PolicyDecision>;

export const RunSource = Type.Object(
  {
    registry: Type.String(),
    ref: Type.Union([Type.String(), Type.Null()]),
    commitSha: Type.Union([Type.String(), Type.Null()]),
    pipelineHash: Type.String(),
    promptHashes: Type.Record(Type.String(), Type.String()),
    schemaHashes: Type.Record(Type.String(), Type.String()),
  },
  { $id: "RunSource", additionalProperties: false },
);
export type RunSource = Static<typeof RunSource>;

export const RunResult = Type.Object(
  {
    runId: Type.String(),
    pipelineId: Type.String(),
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("partial"),
    ]),
    startedAt: Type.String(),
    completedAt: Type.Union([Type.String(), Type.Null()]),
    input: Type.String(),
    source: RunSource,
    providers: Type.Array(Type.String()),
    recursion: Type.Object({
      enabled: Type.Boolean(),
      maxDepth: Type.Number(),
      currentDepth: Type.Number(),
      carryForwardStrategy: Type.Union([Type.String(), Type.Null()]),
    }),
    channels: Type.Array(ChannelResult),
    synthesis: Type.Union([ChannelResult, Type.Null()]),
    /** When this run resumed a prior partial run, the prior run's id. */
    resumedFrom: Type.Union([Type.String(), Type.Null()]),
    /** When this run is a replay from a run bundle, the original run's id. */
    replayedFrom: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    /** Enforcement-policy decisions recorded at the before/after-channel hooks. */
    policy: Type.Array(PolicyDecision),
    validation: Type.Object({
      valid: Type.Boolean(),
      errors: Type.Array(Type.Unknown()),
    }),
    telemetry: Type.Object({
      traceId: Type.Union([Type.String(), Type.Null()]),
    }),
    artifacts: Type.Object({
      bundlePath: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  { $id: "RunResult", additionalProperties: false },
);
export type RunResult = Static<typeof RunResult>;
