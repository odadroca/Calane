import type { ChannelResult, RunResult } from "../specs/RunResult.js";

export interface RecursionDecision {
  shouldRecurse: boolean;
  reason: string;
}

/**
 * PolicyPluginInterface — a functional plugin that decides recursion. Recursion
 * is explicit and bounded: no model-decided loop count, no hidden recursion.
 */
export interface PolicyPluginInterface {
  readonly name: string;
  decideRecursion(args: {
    result: RunResult;
    currentDepth: number;
    maxDepth: number;
    elapsedMs: number;
    totalCostUsd: number | null;
    maxRuntimeMs?: number;
    maxCostUsd?: number;
  }): RecursionDecision;
}

/**
 * Decision returned by a policy's `beforeChannel` hook.
 *   - `proceed`: run the channel normally.
 *   - `skip`: do not run this channel; continue with the rest of the run.
 *   - `abort`: halt the whole run (active provider calls are aborted via
 *     AbortSignal where supported).
 */
export type BeforeChannelDecision = "proceed" | "skip" | "abort";

/**
 * Decision returned by a policy's `afterChannel` hook.
 *   - `continue`: keep running the pipeline.
 *   - `halt`: stop the run after this channel (no further channels run).
 */
export type AfterChannelDecision = "continue" | "halt";

/** Context passed to a policy at the `beforeChannel` hook. */
export interface BeforeChannelContext {
  runId: string;
  channelId: string;
  isSynthesis: boolean;
  recursionDepth: number;
  /** Channel results already completed in this run so far. */
  completedChannels: ChannelResult[];
}

/** Context passed to a policy at the `afterChannel` hook. */
export interface AfterChannelContext {
  runId: string;
  channelId: string;
  isSynthesis: boolean;
  recursionDepth: number;
  /** The result just produced by the channel that ran. */
  channelResult: ChannelResult;
  /** Channel results completed in this run so far (including `channelResult`). */
  completedChannels: ChannelResult[];
}

/**
 * A single recorded policy decision. Persisted on `RunResult.policy` and
 * exported to `policy_decisions.json` in the run bundle.
 */
export interface PolicyDecisionRecord {
  policyId: string;
  hook: "beforeChannel" | "afterChannel";
  channelId: string;
  decision: BeforeChannelDecision | AfterChannelDecision;
  reason: string;
}

/**
 * EnforcementPolicyInterface — a policy that can gate channel execution. Unlike
 * the recursion policy (which decides loop continuation), enforcement policies
 * run at two hook points around every channel: `beforeChannel` (gate entry) and
 * `afterChannel` (gate continuation). Policies are plain classes; their *config*
 * is TypeBox-schema'd (see CostBudgetPolicy). Hooks must be pure/synchronous so
 * the executor can dispatch them deterministically in registration order.
 */
export interface EnforcementPolicyInterface {
  /** Stable identifier recorded in PolicyDecisionRecord.policyId. */
  readonly policyId: string;
  beforeChannel?(context: BeforeChannelContext): {
    decision: BeforeChannelDecision;
    reason: string;
  };
  afterChannel?(context: AfterChannelContext): { decision: AfterChannelDecision; reason: string };
}
