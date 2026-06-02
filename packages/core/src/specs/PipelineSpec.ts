import { type Static, Type } from "@sinclair/typebox";
import { ChannelSpec, RepairConfig, RetryConfig } from "./ChannelSpec.js";
import { ProviderSpec } from "./ProviderSpec.js";

/**
 * Structured concurrency policy. `global` caps total in-flight channels across
 * the run; `perProvider` caps in-flight channels per provider id. Replaces the
 * blanket `maxConcurrency` run option (which still acts as a fallback global cap
 * when `concurrency` is absent).
 */
export const ConcurrencyConfig = Type.Object(
  {
    global: Type.Optional(Type.Number({ minimum: 1 })),
    perProvider: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 1 }))),
  },
  { $id: "ConcurrencyConfig", additionalProperties: false },
);
export type ConcurrencyConfig = Static<typeof ConcurrencyConfig>;

/** Pipeline-level defaults inherited by channels that do not set their own. */
export const PipelineDefaults = Type.Object(
  {
    retry: Type.Optional(RetryConfig),
    repair: Type.Optional(RepairConfig),
  },
  { $id: "PipelineDefaults", additionalProperties: false },
);
export type PipelineDefaults = Static<typeof PipelineDefaults>;

export const CarryForwardStrategy = Type.Union(
  [
    Type.Literal("synthesis_only"),
    Type.Literal("full_context"),
    Type.Literal("dissent_only"),
    Type.Literal("unresolved_questions_only"),
    Type.Literal("highest_confidence_claims_only"),
  ],
  { $id: "CarryForwardStrategy" },
);
export type CarryForwardStrategy = Static<typeof CarryForwardStrategy>;

export const RecursionConfig = Type.Object(
  {
    enabled: Type.Boolean(),
    maxDepth: Type.Number({ minimum: 1 }),
    maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
    maxRuntimeMs: Type.Optional(Type.Number({ minimum: 0 })),
    carryForwardStrategy: Type.Optional(CarryForwardStrategy),
  },
  { $id: "RecursionConfig", additionalProperties: false },
);
export type RecursionConfig = Static<typeof RecursionConfig>;

/**
 * Named synthesis variant. Purely descriptive metadata: the variant is realized
 * by the synthesis channel's prompt template (and optional schema) chosen by the
 * pipeline author. The executor performs NO variant-specific logic — `variant`
 * records which synthesis method this channel implements so callers and bundles
 * can report it. `consensus` is the default (the MVP synthesis behavior).
 */
export const SynthesisVariant = Type.Union(
  [
    Type.Literal("consensus"),
    Type.Literal("steelman"),
    Type.Literal("adversarial"),
    Type.Literal("weighted"),
  ],
  { $id: "SynthesisVariant" },
);
export type SynthesisVariant = Static<typeof SynthesisVariant>;

/**
 * The synthesis channel. A {@link ChannelSpec} plus an optional `variant` naming
 * the synthesis method it implements. Synthesis remains "just a channel that
 * consumes prior channel results"; `variant` adds no execution branch.
 */
export const SynthesisSpec = Type.Composite(
  [ChannelSpec, Type.Object({ variant: Type.Optional(SynthesisVariant) })],
  { $id: "SynthesisSpec", additionalProperties: false },
);
export type SynthesisSpec = Static<typeof SynthesisSpec>;

/**
 * The full pipeline definition, authored as YAML on disk. Synthesis is just
 * another channel that consumes prior channel results.
 */
export const PipelineSpec = Type.Object(
  {
    id: Type.String(),
    name: Type.Optional(Type.String()),
    version: Type.String(),
    description: Type.Optional(Type.String()),
    recursion: Type.Optional(RecursionConfig),
    /** Defaults (retry/repair) inherited by channels that do not override them. */
    defaults: Type.Optional(PipelineDefaults),
    /** Structured concurrency policy (global + per-provider caps). */
    concurrency: Type.Optional(ConcurrencyConfig),
    providers: Type.Array(ProviderSpec),
    channels: Type.Array(ChannelSpec),
    synthesis: Type.Optional(SynthesisSpec),
  },
  { $id: "PipelineSpec", additionalProperties: false },
);

export type PipelineSpec = Static<typeof PipelineSpec>;
