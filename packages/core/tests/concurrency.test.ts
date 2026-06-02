import { describe, expect, it } from "vitest";
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
import type { PipelineSpec } from "../src/specs/PipelineSpec.js";
import { canonicalJson, sha256 } from "../src/util/hash.js";

class MemStore implements ResultStoreInterface {
  readonly name = "mem";
  private raw = new Map<string, string>();
  async saveRun(_r: RunResult): Promise<void> {}
  async getRun(): Promise<RunResult | null> {
    return null;
  }
  async listRuns(): Promise<string[]> {
    return [];
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

/** Shared counter tracking true global in-flight concurrency across providers. */
class GlobalTracker {
  inFlight = 0;
  maxInFlight = 0;
  enter() {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
  }
  leave() {
    this.inFlight -= 1;
  }
}

/** Provider that tracks the maximum number of concurrent in-flight executes. */
class TrackingProvider implements ProviderAdapterInterface {
  inFlight = 0;
  maxInFlight = 0;
  constructor(
    readonly type: string,
    private readonly global?: GlobalTracker,
  ) {}
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.global?.enter();
    await new Promise((r) => setTimeout(r, 15));
    this.global?.leave();
    this.inFlight -= 1;
    return {
      rawOutput: JSON.stringify({ c: request.channelId }),
      model: `${this.type}-1`,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
  }
}

class MemRegistry implements PromptRegistryInterface {
  readonly name = "mem";
  constructor(private spec: PipelineSpec) {}
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
    return "p";
  }
  async loadSchema(): Promise<unknown> {
    return { type: "object", additionalProperties: true };
  }
}

function specWithConcurrency(concurrency: PipelineSpec["concurrency"]): PipelineSpec {
  return {
    id: "conc",
    version: "0.1.0",
    concurrency,
    providers: [
      { id: "alpha", type: "alpha" },
      { id: "beta", type: "beta" },
    ],
    // 4 channels on alpha, 4 on beta.
    channels: [
      ...["a1", "a2", "a3", "a4"].map((id) => ({
        id,
        executionMode: "direct_provider" as const,
        prompt: "p",
        provider: "alpha",
      })),
      ...["b1", "b2", "b3", "b4"].map((id) => ({
        id,
        executionMode: "direct_provider" as const,
        prompt: "p",
        provider: "beta",
      })),
    ],
  };
}

describe("concurrency hardening (S10)", () => {
  it("honors per-provider concurrency caps", async () => {
    const spec = specWithConcurrency({ global: 8, perProvider: { alpha: 2, beta: 1 } });
    const alpha = new TrackingProvider("alpha");
    const beta = new TrackingProvider("beta");
    const executor = new PipelineExecutor({
      registry: new MemRegistry(spec),
      providers: new ProviderRegistry().register(alpha).register(beta),
      store: new MemStore(),
    });

    await executor.run({ pipelineId: "conc", input: "x" });

    expect(alpha.maxInFlight).toBeLessThanOrEqual(2);
    expect(beta.maxInFlight).toBeLessThanOrEqual(1);
    // sanity: alpha was allowed more parallelism than beta
    expect(alpha.maxInFlight).toBeGreaterThan(beta.maxInFlight);
  });

  it("honors the global cap across providers", async () => {
    const spec = specWithConcurrency({ global: 2 });
    const global = new GlobalTracker();
    const alpha = new TrackingProvider("alpha", global);
    const beta = new TrackingProvider("beta", global);
    const executor = new PipelineExecutor({
      registry: new MemRegistry(spec),
      providers: new ProviderRegistry().register(alpha).register(beta),
      store: new MemStore(),
    });

    await executor.run({ pipelineId: "conc", input: "x" });

    // True global in-flight never exceeds the global cap of 2.
    expect(global.maxInFlight).toBeLessThanOrEqual(2);
    expect(global.maxInFlight).toBeGreaterThan(1); // some parallelism happened
  });

  it("falls back to maxConcurrency when no concurrency policy is set", async () => {
    const spec = specWithConcurrency(undefined);
    const global = new GlobalTracker();
    const alpha = new TrackingProvider("alpha", global);
    const beta = new TrackingProvider("beta", global);
    const executor = new PipelineExecutor({
      registry: new MemRegistry(spec),
      providers: new ProviderRegistry().register(alpha).register(beta),
      store: new MemStore(),
    });

    const result = await executor.run({
      pipelineId: "conc",
      input: "x",
      options: { maxConcurrency: 1 },
    });
    // global cap of 1 → at most one in-flight anywhere.
    expect(global.maxInFlight).toBeLessThanOrEqual(1);
    expect(result.channels).toHaveLength(8);
  });
});
