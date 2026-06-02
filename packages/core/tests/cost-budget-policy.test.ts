import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CostBudgetPolicy,
  PipelineExecutor,
  type PromptRegistryInterface,
  type ProviderAdapterInterface,
  ProviderRegistry,
  type ProviderRequest,
  type ProviderResponse,
  type ResolvedPipeline,
  type ResultStoreInterface,
  RunBundleExporter,
  type RunResult,
  type TelemetryEvent,
  type TelemetrySinkInterface,
} from "../src/index.js";
import type { PipelineSpec } from "../src/specs/PipelineSpec.js";
import { canonicalJson, sha256 } from "../src/util/hash.js";

/** Telemetry sink that captures every emitted event for assertions. */
class CapturingSink implements TelemetrySinkInterface {
  readonly name = "capturing";
  readonly events: TelemetryEvent[] = [];
  async startTrace(): Promise<string | null> {
    return "trace-abc";
  }
  async emit(event: TelemetryEvent): Promise<void> {
    this.events.push(event);
  }
  async endTrace(): Promise<void> {}
}

/** Provider that reports a fixed per-call cost so budget policies can bind. */
class CostingProvider implements ProviderAdapterInterface {
  readonly type = "costing";
  constructor(private readonly costPerCall: number) {}
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    return {
      rawOutput: JSON.stringify({ ok: true, channel: request.channelId }),
      model: "costing-1",
      usage: { inputTokens: 10, outputTokens: 10, costUsd: this.costPerCall },
    };
  }
}

/** Minimal in-memory store. */
class MemStore implements ResultStoreInterface {
  readonly name = "mem";
  private runs = new Map<string, RunResult>();
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

/** In-memory registry serving a flat N-channel pipeline. */
class MemRegistry implements PromptRegistryInterface {
  readonly name = "mem";
  constructor(private readonly spec: PipelineSpec) {}
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
  async loadPrompt(): Promise<string> {
    return "analyze {{input}}";
  }
  async loadSchema(): Promise<unknown> {
    return { type: "object", properties: {}, additionalProperties: true };
  }
}

function makeSpec(channelCount: number): PipelineSpec {
  return {
    id: "budget-test",
    version: "0.1.0",
    providers: [{ id: "costing", type: "costing" }],
    channels: Array.from({ length: channelCount }, (_, i) => ({
      id: `c${i + 1}`,
      executionMode: "direct_provider" as const,
      prompt: `prompts/c${i + 1}.md`,
    })),
  };
}

function makeExecutor(spec: PipelineSpec, cost: number, policy: CostBudgetPolicy) {
  const providers = new ProviderRegistry().register(new CostingProvider(cost));
  const store = new MemStore();
  const executor = new PipelineExecutor({
    registry: new MemRegistry(spec),
    providers,
    store,
    policies: [policy],
  });
  return { executor, store };
}

describe("CostBudgetPolicy (S7)", () => {
  it("halts the run when the per-run budget is exceeded mid-execution", async () => {
    // 5 channels @ $0.01 each = $0.05 max; budget $0.025 → halts after ~2-3.
    const spec = makeSpec(5);
    const policy = new CostBudgetPolicy({ maxCostUsdPerRun: 0.025 });
    const { executor } = makeExecutor(spec, 0.01, policy);

    const result = await executor.run({ pipelineId: "budget-test", input: "x" });

    expect(result.channels.length).toBeLessThan(5);
    const haltDecisions = result.policy.filter(
      (d) => d.policyId === "cost-budget" && (d.decision === "halt" || d.decision === "abort"),
    );
    expect(haltDecisions.length).toBeGreaterThanOrEqual(1);
  });

  it("halts when a single channel exceeds the per-channel ceiling", async () => {
    const spec = makeSpec(3);
    const policy = new CostBudgetPolicy({ maxCostUsdPerChannel: 0.005 });
    const { executor } = makeExecutor(spec, 0.01, policy);

    const result = await executor.run({ pipelineId: "budget-test", input: "x" });

    const channelHalt = result.policy.find(
      (d) => d.hook === "afterChannel" && d.decision === "halt",
    );
    expect(channelHalt).toBeDefined();
    expect(channelHalt?.reason).toMatch(/per-channel ceiling/);
  });

  it("allows the run to complete when the budget is not exceeded", async () => {
    const spec = makeSpec(3);
    const policy = new CostBudgetPolicy({ maxCostUsdPerRun: 10, maxCostUsdPerChannel: 10 });
    const { executor } = makeExecutor(spec, 0.01, policy);

    const result = await executor.run({ pipelineId: "budget-test", input: "x" });

    expect(result.channels).toHaveLength(3);
    expect(result.policy.some((d) => d.decision === "halt" || d.decision === "abort")).toBe(false);
    // every decision is a proceed/continue
    expect(result.policy.every((d) => ["proceed", "continue"].includes(d.decision))).toBe(true);
  });

  it("records before/after-channel decisions on RunResult.policy", async () => {
    const spec = makeSpec(2);
    const policy = new CostBudgetPolicy({ maxCostUsdPerRun: 10 });
    const { executor } = makeExecutor(spec, 0.01, policy);

    const result = await executor.run({ pipelineId: "budget-test", input: "x" });

    expect(result.policy.some((d) => d.hook === "beforeChannel")).toBe(true);
    expect(result.policy.some((d) => d.hook === "afterChannel")).toBe(true);
    for (const d of result.policy) {
      expect(d.policyId).toBe("cost-budget");
      expect(typeof d.reason).toBe("string");
    }
  });

  it("exports policy_decisions.json in the run bundle", async () => {
    const spec = makeSpec(3);
    const policy = new CostBudgetPolicy({ maxCostUsdPerRun: 0.015 });
    const { executor, store } = makeExecutor(spec, 0.01, policy);
    const result = await executor.run({ pipelineId: "budget-test", input: "x" });

    const out = await mkdtemp(join(tmpdir(), "policy-bundle-"));
    try {
      const exporter = new RunBundleExporter(store);
      const { files, bundlePath } = await exporter.export(result, { outDir: out });
      expect(files).toContain("policy_decisions.json");
      const written = JSON.parse(await readFile(join(bundlePath, "policy_decisions.json"), "utf8"));
      expect(Array.isArray(written)).toBe(true);
      expect(written).toEqual(result.policy);
      expect(written.length).toBeGreaterThan(0);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("emits policy.decision telemetry events with a policy.decision attribute", async () => {
    const spec = makeSpec(2);
    const policy = new CostBudgetPolicy({ maxCostUsdPerRun: 10 });
    const providers = new ProviderRegistry().register(new CostingProvider(0.01));
    const sink = new CapturingSink();
    const executor = new PipelineExecutor({
      registry: new MemRegistry(spec),
      providers,
      store: new MemStore(),
      telemetry: sink,
      policies: [policy],
    });
    await executor.run({ pipelineId: "budget-test", input: "x" });

    const policyEvents = sink.events.filter((e) => e.type === "policy.decision");
    expect(policyEvents.length).toBeGreaterThan(0);
    for (const e of policyEvents) {
      expect(e.attributes?.["policy.decision"]).toBeDefined();
      expect(e.attributes?.["policy.id"]).toBe("cost-budget");
    }
  });

  it("runs with no enforcement policies registered (back-compat)", async () => {
    const spec = makeSpec(2);
    const providers = new ProviderRegistry().register(new CostingProvider(0.01));
    const executor = new PipelineExecutor({
      registry: new MemRegistry(spec),
      providers,
      store: new MemStore(),
    });
    const result = await executor.run({ pipelineId: "budget-test", input: "x" });
    expect(result.channels).toHaveLength(2);
    expect(result.policy).toEqual([]);
  });
});
