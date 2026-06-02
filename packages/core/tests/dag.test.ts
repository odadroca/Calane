import { describe, expect, it } from "vitest";
import { buildExecutionPlan, topoLevels } from "../src/executor/ExecutionPlan.js";
import {
  PipelineExecutor,
  type PromptRegistryInterface,
  type ProviderAdapterInterface,
  ProviderRegistry,
  type ProviderRequest,
  type ProviderResponse,
  type ResolvedPipeline,
  type ResultStoreInterface,
  type RunResult,
} from "../src/index.js";
import { PromptRenderer } from "../src/rendering/PromptRenderer.js";
import type { ChannelSpec } from "../src/specs/ChannelSpec.js";
import type { PipelineSpec } from "../src/specs/PipelineSpec.js";
import { canonicalJson, sha256 } from "../src/util/hash.js";

class MemStore implements ResultStoreInterface {
  readonly name = "mem";
  runs = new Map<string, RunResult>();
  private raw = new Map<string, string>();
  async saveRun(result: RunResult): Promise<void> {
    this.runs.set(result.runId, result);
  }
  async getRun(runId: string): Promise<RunResult | null> {
    return this.runs.get(runId) ?? null;
  }
  async listRuns(): Promise<string[]> {
    return [...this.runs.keys()];
  }
  async saveRawOutput(runId: string, channelKey: string, raw: string): Promise<string> {
    const ref = `raw/${channelKey}.txt`;
    this.raw.set(`${runId}:${ref}`, raw);
    return ref;
  }
  async getRawOutput(runId: string, ref: string): Promise<string | null> {
    return this.raw.get(`${runId}:${ref}`) ?? null;
  }
}

/** Records the order channels start and the prompt each received. */
class TrackingProvider implements ProviderAdapterInterface {
  readonly type = "track";
  startOrder: string[] = [];
  prompts: Record<string, string> = {};
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    this.startOrder.push(request.channelId);
    this.prompts[request.channelId] = request.prompt;
    return {
      rawOutput: JSON.stringify({ channel: request.channelId, value: request.channelId }),
      model: "track-1",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
  }
}

class MemRegistry implements PromptRegistryInterface {
  readonly name = "mem";
  constructor(
    private spec: PipelineSpec,
    private prompts: Record<string, string>,
  ) {}
  async listPipelines(): Promise<string[]> {
    return [this.spec.id];
  }
  async resolvePipeline(): Promise<ResolvedPipeline> {
    return {
      spec: this.spec,
      registry: "mem",
      ref: null,
      commitSha: null,
      pipelineHash: `sha256:${sha256(canonicalJson(this.spec))}`,
    };
  }
  async loadPrompt(p: string): Promise<string> {
    return this.prompts[p] ?? "{{input}}";
  }
  async loadSchema(): Promise<unknown> {
    throw new Error("no schema");
  }
}

function channel(id: string, dependsOn?: string[]): ChannelSpec {
  return {
    id,
    executionMode: "direct_provider",
    prompt: `prompts/${id}.md`,
    ...(dependsOn ? { dependsOn } : {}),
  };
}

function mkExecutor(spec: PipelineSpec, prompts: Record<string, string> = {}) {
  const store = new MemStore();
  const provider = new TrackingProvider();
  const providers = new ProviderRegistry().register(provider);
  const registry = new MemRegistry(spec, prompts);
  const executor = new PipelineExecutor({ registry, providers, store });
  return { executor, provider, store };
}

describe("S14 — ExecutionPlan topological ordering", () => {
  it("flat pipeline (no dependsOn) is a single level in declared order", () => {
    const spec: PipelineSpec = {
      id: "flat",
      version: "0.1.0",
      providers: [{ id: "track", type: "track" }],
      channels: [channel("a"), channel("b"), channel("c")],
    };
    const plan = buildExecutionPlan(spec);
    expect(plan.isDag).toBe(false);
    expect(plan.levels).toHaveLength(1);
    expect(plan.topoOrder).toEqual(["a", "b", "c"]);
  });

  it("linear DAG resolves to one channel per level", () => {
    const spec: PipelineSpec = {
      id: "linear",
      version: "0.1.0",
      providers: [{ id: "track", type: "track" }],
      channels: [channel("a"), channel("b", ["a"]), channel("c", ["b"])],
    };
    const plan = buildExecutionPlan(spec);
    expect(plan.isDag).toBe(true);
    expect(plan.levels.map((l) => l.map((p) => p.channel.id))).toEqual([["a"], ["b"], ["c"]]);
    expect(plan.topoOrder).toEqual(["a", "b", "c"]);
  });

  it("branching DAG groups independent channels into the same level", () => {
    const spec: PipelineSpec = {
      id: "branch",
      version: "0.1.0",
      providers: [{ id: "track", type: "track" }],
      channels: [
        channel("root"),
        channel("left", ["root"]),
        channel("right", ["root"]),
        channel("merge", ["left", "right"]),
      ],
    };
    const plan = buildExecutionPlan(spec);
    const levels = plan.levels.map((l) => l.map((p) => p.channel.id));
    expect(levels).toEqual([["root"], ["left", "right"], ["merge"]]);
  });

  it("topoLevels throws on a cycle", () => {
    const channels = [channel("a", ["b"]), channel("b", ["a"])].map((c) => ({
      channel: c,
      provider: { id: "track", type: "track" },
      isSynthesis: false,
    }));
    expect(() => topoLevels(channels)).toThrow(/cyclic/i);
  });
});

describe("S14 — executor runs channels in topological order", () => {
  it("linear DAG executes a -> b -> c in dependency order", async () => {
    const spec: PipelineSpec = {
      id: "linear_run",
      version: "0.1.0",
      providers: [{ id: "track", type: "track" }],
      channels: [channel("a"), channel("b", ["a"]), channel("c", ["b"])],
    };
    const { executor, provider } = mkExecutor(spec);
    const run = await executor.run({ pipelineId: "linear_run", input: "x" });
    expect(run.status).toBe("completed");
    expect(provider.startOrder).toEqual(["a", "b", "c"]);
  });

  it("branching DAG runs root before its dependents and merge last", async () => {
    const spec: PipelineSpec = {
      id: "branch_run",
      version: "0.1.0",
      providers: [{ id: "track", type: "track" }],
      channels: [
        channel("root"),
        channel("left", ["root"]),
        channel("right", ["root"]),
        channel("merge", ["left", "right"]),
      ],
    };
    const { executor, provider } = mkExecutor(spec);
    await executor.run({ pipelineId: "branch_run", input: "x" });
    const order = provider.startOrder;
    expect(order[0]).toBe("root");
    expect(order[order.length - 1]).toBe("merge");
    expect(order.indexOf("left")).toBeGreaterThan(order.indexOf("root"));
    expect(order.indexOf("right")).toBeGreaterThan(order.indexOf("root"));
  });

  it("mixed pipeline: independent channel + a dependent chain coexist", async () => {
    const spec: PipelineSpec = {
      id: "mixed_run",
      version: "0.1.0",
      providers: [{ id: "track", type: "track" }],
      channels: [channel("solo"), channel("base"), channel("derived", ["base"])],
    };
    const { executor, provider } = mkExecutor(spec);
    const run = await executor.run({ pipelineId: "mixed_run", input: "x" });
    expect(run.status).toBe("completed");
    expect(provider.startOrder.indexOf("derived")).toBeGreaterThan(
      provider.startOrder.indexOf("base"),
    );
    expect(provider.startOrder).toContain("solo");
  });

  it("exposes upstream output to a downstream prompt via {{channel_results.<id>.parsed}}", async () => {
    const spec: PipelineSpec = {
      id: "passdata",
      version: "0.1.0",
      providers: [{ id: "track", type: "track" }],
      channels: [channel("base"), channel("consumer", ["base"])],
    };
    const prompts = {
      "prompts/base.md": "base prompt {{input}}",
      "prompts/consumer.md": "UP={{channel_results.base.parsed}} RAW={{channel_results.base.raw}}",
    };
    const { executor, provider } = mkExecutor(spec, prompts);
    await executor.run({ pipelineId: "passdata", input: "x" });
    const consumerPrompt = provider.prompts.consumer!;
    // base channel produced { channel: "base", value: "base" }.
    expect(consumerPrompt).toContain('"value": "base"');
    expect(consumerPrompt).toContain('"channel": "base"');
    // The {{channel_results.base.raw}} variable was substituted (not left raw).
    expect(consumerPrompt).not.toContain("{{channel_results.base.raw}}");
  });
});
