import type { PolicyPluginInterface, RecursionDecision } from "../plugins/PolicyPlugin.js";

/**
 * Default bounded recursion policy. Recursion is explicit: it stops at maxDepth
 * and at optional cost/runtime ceilings. The model never decides loop count.
 */
export class DefaultRecursionPolicy implements PolicyPluginInterface {
  readonly name = "default-bounded";

  decideRecursion(args: {
    currentDepth: number;
    maxDepth: number;
    elapsedMs: number;
    totalCostUsd: number | null;
    maxRuntimeMs?: number;
    maxCostUsd?: number;
  }): RecursionDecision {
    if (args.currentDepth >= args.maxDepth) {
      return { shouldRecurse: false, reason: `reached maxDepth ${args.maxDepth}` };
    }
    if (args.maxRuntimeMs !== undefined && args.elapsedMs >= args.maxRuntimeMs) {
      return { shouldRecurse: false, reason: `reached maxRuntimeMs ${args.maxRuntimeMs}` };
    }
    if (
      args.maxCostUsd !== undefined &&
      args.totalCostUsd !== null &&
      args.totalCostUsd >= args.maxCostUsd
    ) {
      return { shouldRecurse: false, reason: `reached maxCostUsd ${args.maxCostUsd}` };
    }
    return { shouldRecurse: true, reason: "within bounds" };
  }
}
