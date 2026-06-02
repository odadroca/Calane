import type { ChannelSpec } from "../specs/ChannelSpec.js";
import type { PipelineSpec } from "../specs/PipelineSpec.js";
import type { ProviderSpec } from "../specs/ProviderSpec.js";

export interface PlannedChannel {
  channel: ChannelSpec;
  provider: ProviderSpec;
  isSynthesis: boolean;
}

export interface ExecutionPlan {
  pipelineId: string;
  channels: PlannedChannel[];
  /**
   * Topologically ordered execution levels. Each level is a set of channels with
   * no unsatisfied dependencies on later levels; channels within a level are
   * mutually independent and may run in parallel. For a flat pipeline (no
   * `dependsOn` anywhere) this is a single level containing all channels in
   * declared order — preserving the prior concurrent behavior exactly.
   */
  levels: PlannedChannel[][];
  /** Whether any channel declares `dependsOn` (i.e. DAG ordering is in effect). */
  isDag: boolean;
  /** The resolved topological order of channel ids (flattened `levels`). */
  topoOrder: string[];
  synthesis: PlannedChannel | null;
  maxDepth: number;
  recursionEnabled: boolean;
  carryForwardStrategy: string | null;
  providers: string[];
}

/**
 * Build an explicit, fully-resolved execution plan. No hidden recursion, no
 * model-decided loop count — channel list, providers, depth, synthesis, and the
 * topological execution order are all materialized up front.
 */
export function buildExecutionPlan(
  spec: PipelineSpec,
  options?: { providers?: string[]; depth?: number },
): ExecutionPlan {
  const allowed = options?.providers;
  const providerById = new Map(spec.providers.map((p) => [p.id, p]));

  const resolveProvider = (channel: ChannelSpec): ProviderSpec => {
    // Channel-level provider override, else first allowed, else first declared.
    if (channel.provider) {
      const p = providerById.get(channel.provider);
      if (!p) throw new Error(`Channel "${channel.id}" references unknown provider`);
      return p;
    }
    if (allowed && allowed.length > 0) {
      for (const id of allowed) {
        const p = providerById.get(id);
        if (p) return p;
      }
    }
    const first = spec.providers[0];
    if (!first) throw new Error(`Pipeline "${spec.id}" declares no providers`);
    return first;
  };

  const channels: PlannedChannel[] = spec.channels.map((channel) => ({
    channel,
    provider: resolveProvider(channel),
    isSynthesis: false,
  }));

  const isDag = spec.channels.some((c) => (c.dependsOn?.length ?? 0) > 0);
  const levels = isDag ? topoLevels(channels) : channels.length > 0 ? [channels] : [];
  const topoOrder = levels.flat().map((p) => p.channel.id);

  const synthesis: PlannedChannel | null = spec.synthesis
    ? { channel: spec.synthesis, provider: resolveProvider(spec.synthesis), isSynthesis: true }
    : null;

  const recursionEnabled = spec.recursion?.enabled ?? false;
  const specMaxDepth = spec.recursion?.maxDepth ?? 1;
  const maxDepth = options?.depth !== undefined ? options.depth : specMaxDepth;

  const usedProviders = new Set<string>();
  for (const c of channels) usedProviders.add(c.provider.id);
  if (synthesis) usedProviders.add(synthesis.provider.id);

  return {
    pipelineId: spec.id,
    channels,
    levels,
    isDag,
    topoOrder,
    synthesis,
    maxDepth,
    recursionEnabled,
    carryForwardStrategy: spec.recursion?.carryForwardStrategy ?? null,
    providers: [...usedProviders],
  };
}

/**
 * Kahn's algorithm producing dependency levels. Declared order is preserved
 * within each level so output is deterministic. Throws on an unknown dependency
 * id or a cycle — `validate-pipeline` (S6) is the user-facing gate, but the
 * executor must also refuse to silently mis-order a malformed graph.
 */
export function topoLevels(channels: PlannedChannel[]): PlannedChannel[][] {
  const byId = new Map(channels.map((p) => [p.channel.id, p]));
  const indegree = new Map<string, number>();
  for (const p of channels) {
    let deg = 0;
    for (const dep of p.channel.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`Channel "${p.channel.id}" dependsOn unknown channel "${dep}"`);
      }
      deg += 1;
    }
    indegree.set(p.channel.id, deg);
  }

  const levels: PlannedChannel[][] = [];
  const remaining = new Set(channels.map((p) => p.channel.id));

  while (remaining.size > 0) {
    // Ready = remaining channels whose indegree is 0, in declared order.
    const ready = channels.filter(
      (p) => remaining.has(p.channel.id) && indegree.get(p.channel.id) === 0,
    );
    if (ready.length === 0) {
      const cyclic = [...remaining].join(", ");
      throw new Error(`Cyclic channel dependencies among: ${cyclic}`);
    }
    levels.push(ready);
    for (const p of ready) remaining.delete(p.channel.id);
    // Decrement indegree of channels depending on the just-resolved ones.
    for (const p of channels) {
      if (!remaining.has(p.channel.id)) continue;
      for (const dep of p.channel.dependsOn ?? []) {
        if (ready.some((r) => r.channel.id === dep)) {
          indegree.set(p.channel.id, (indegree.get(p.channel.id) ?? 0) - 1);
        }
      }
    }
  }

  return levels;
}
