import { type Static, Type } from "@sinclair/typebox";
import type {
  AfterChannelContext,
  AfterChannelDecision,
  BeforeChannelContext,
  BeforeChannelDecision,
  EnforcementPolicyInterface,
} from "../plugins/PolicyPlugin.js";
import type { ChannelResult } from "../specs/RunResult.js";

/**
 * TypeBox config schema for CostBudgetPolicy. This is the single source of
 * truth for the policy configuration; pipeline YAML authors supply an object of
 * this shape under `pipeline.policies.costBudget` (validated by the executor).
 */
export const CostBudgetPolicyConfig = Type.Object(
  {
    /** Hard ceiling on summed channel cost for the whole run (USD). */
    maxCostUsdPerRun: Type.Optional(Type.Number({ minimum: 0 })),
    /** Hard ceiling on a single channel's cost (USD). */
    maxCostUsdPerChannel: Type.Optional(Type.Number({ minimum: 0 })),
    /**
     * Safety margin applied to the known (already-incurred) run cost before
     * comparing against `maxCostUsdPerRun`. A value of 0.1 treats the budget as
     * exceeded once known cost reaches 90% of the ceiling. Known cost only — the
     * policy never predicts the cost of an unrun channel.
     */
    safetyMargin: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { $id: "CostBudgetPolicyConfig", additionalProperties: false },
);
export type CostBudgetPolicyConfig = Static<typeof CostBudgetPolicyConfig>;

const POLICY_ID = "cost-budget";

/**
 * CostBudgetPolicy — enforces per-run and per-channel cost ceilings using only
 * known (already-incurred) cost plus a configurable safety margin. It never
 * predicts the cost of a channel that has not yet run.
 *
 *   - `beforeChannel`: if the known run cost so far has reached the
 *     margin-adjusted per-run ceiling, abort the run (no point starting another
 *     channel).
 *   - `afterChannel`: if the channel that just ran exceeded the per-channel
 *     ceiling, or the run total reached the margin-adjusted per-run ceiling,
 *     halt the run.
 */
export class CostBudgetPolicy implements EnforcementPolicyInterface {
  readonly policyId = POLICY_ID;
  private readonly maxPerRun?: number;
  private readonly maxPerChannel?: number;
  private readonly margin: number;

  constructor(config: CostBudgetPolicyConfig) {
    this.maxPerRun = config.maxCostUsdPerRun;
    this.maxPerChannel = config.maxCostUsdPerChannel;
    this.margin = config.safetyMargin ?? 0;
  }

  /** The margin-adjusted per-run ceiling (budget reduced by the safety margin). */
  private effectivePerRunCeiling(): number | undefined {
    if (this.maxPerRun === undefined) return undefined;
    return this.maxPerRun * (1 - this.margin);
  }

  beforeChannel(context: BeforeChannelContext): {
    decision: BeforeChannelDecision;
    reason: string;
  } {
    const ceiling = this.effectivePerRunCeiling();
    if (ceiling !== undefined) {
      const knownCost = sumCost(context.completedChannels);
      if (knownCost >= ceiling) {
        return {
          decision: "abort",
          reason: `known run cost ${fmt(knownCost)} reached per-run ceiling ${fmt(ceiling)} (maxCostUsdPerRun=${this.maxPerRun}, safetyMargin=${this.margin})`,
        };
      }
    }
    return { decision: "proceed", reason: "within cost budget" };
  }

  afterChannel(context: AfterChannelContext): {
    decision: AfterChannelDecision;
    reason: string;
  } {
    const channelCost = context.channelResult.usage.costUsd ?? 0;
    if (this.maxPerChannel !== undefined && channelCost > this.maxPerChannel) {
      return {
        decision: "halt",
        reason: `channel cost ${fmt(channelCost)} exceeded per-channel ceiling ${fmt(this.maxPerChannel)}`,
      };
    }
    const ceiling = this.effectivePerRunCeiling();
    if (ceiling !== undefined) {
      const knownCost = sumCost(context.completedChannels);
      if (knownCost >= ceiling) {
        return {
          decision: "halt",
          reason: `known run cost ${fmt(knownCost)} reached per-run ceiling ${fmt(ceiling)} (maxCostUsdPerRun=${this.maxPerRun}, safetyMargin=${this.margin})`,
        };
      }
    }
    return { decision: "continue", reason: "within cost budget" };
  }
}

function sumCost(channels: ChannelResult[]): number {
  let sum = 0;
  for (const c of channels) {
    if (typeof c.usage.costUsd === "number") sum += c.usage.costUsd;
  }
  return sum;
}

function fmt(n: number): string {
  return `$${n.toFixed(6)}`;
}
