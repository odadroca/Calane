import { describe, expect, it } from "vitest";
import { PipelineExecutor } from "../src/executor/PipelineExecutor.js";
import type { PromptRegistryInterface, ResolvedPipeline } from "../src/plugins/PromptRegistry.js";
import {
  type ProviderAdapterInterface,
  ProviderRegistry,
  type ProviderRequest,
  type ProviderResponse,
} from "../src/plugins/ProviderAdapter.js";
import type { ResultStoreInterface } from "../src/plugins/ResultStore.js";
import {
  DEFAULT_WEIGHTS,
  ModelSelector,
  renderSelectionTable,
} from "../src/selection/ModelSelector.js";
import type { PipelineSpec } from "../src/specs/PipelineSpec.js";
import type { RunResult } from "../src/specs/RunResult.js";

const SCHEMA = {
  type: "object",
  required: ["answer"],
  additionalProperties: false,
  properties: { answer: { type: "string" } },
};

// A pipeline with two declared providers (good/bad) and a channel WITHOUT an
// explicit provider, so the `options.providers` override selects the provider.
const SPEC: PipelineSpec = {
  id: "selftest",
  providers: [
    { id: "good", type: "good" },
    { id: "bad", type: "bad" },
  ],
  channels: [
    {
      id: "analyze",
      executionMode: "direct_provider",
      prompt: "prompts/analyze.md",
      outputSchema: "schemas/answer.json",
    },
  ],
} as unknown as PipelineSpec;

class StubRegistry implements PromptRegistryInterface {
  readonly name = "stub";
  async listPipelines(): Promise<string[]> {
    return [SPEC.id];
  }
  async resolvePipeline(): Promise<ResolvedPipeline> {
    return {
      spec: SPEC,
      registry: "stub",
      ref: null,
      commitSha: null,
      pipelineHash: "sha256:selftest",
    };
  }
  async loadPrompt(): Promise<string> {
    return "answer the question: {{input}}";
  }
  async loadSchema(): Promise<unknown> {
    return SCHEMA;
  }
}

class MemStore implements ResultStoreInterface {
  readonly name = "memory";
  private runs = new Map<string, RunResult>();
  private raw = new Map<string, string>();
  async saveRun(r: RunResult): Promise<void> {
    this.runs.set(r.runId, r);
  }
  async getRun(id: string): Promise<RunResult | null> {
    return this.runs.get(id) ?? null;
  }
  async listRuns(): Promise<string[]> {
    return [...this.runs.keys()];
  }
  async saveRawOutput(runId: string, channelKey: string, raw: string): Promise<string> {
    const ref = `raw/${channelKey}`;
    this.raw.set(`${runId}:${ref}`, raw);
    return ref;
  }
  async getRawOutput(runId: string, ref: string): Promise<string | null> {
    return this.raw.get(`${runId}:${ref}`) ?? null;
  }
}

/** Always returns conforming JSON; cheap and fast. */
class GoodProvider implements ProviderAdapterInterface {
  readonly type = "good";
  async execute(_req: ProviderRequest): Promise<ProviderResponse> {
    return {
      rawOutput: JSON.stringify({ answer: "ok" }),
      model: "good-1",
      usage: { inputTokens: 5, outputTokens: 5, costUsd: 0.001 },
    };
  }
}

/** Always returns invalid JSON; pricier and slower. */
class BadProvider implements ProviderAdapterInterface {
  readonly type = "bad";
  async execute(_req: ProviderRequest): Promise<ProviderResponse> {
    return {
      rawOutput: "not json",
      model: "bad-1",
      usage: { inputTokens: 50, outputTokens: 50, costUsd: 0.05 },
    };
  }
}

function makeExecutor(): PipelineExecutor {
  const providers = new ProviderRegistry().register(new GoodProvider()).register(new BadProvider());
  return new PipelineExecutor({ registry: new StubRegistry(), providers, store: new MemStore() });
}

describe("ModelSelector", () => {
  it("ranks the always-valid provider above the always-invalid provider", async () => {
    const selector = new ModelSelector({ executor: makeExecutor() });
    const report = await selector.select({
      pipelineId: "selftest",
      input: "what is 2+2?",
      providers: ["good", "bad"],
      runs: 3,
    });
    expect(report.recommendation).toBe("good");
    const good = report.providers.find((p) => p.provider === "good");
    const bad = report.providers.find((p) => p.provider === "bad");
    expect(good?.validationPassRate).toBe(1);
    expect(bad?.validationPassRate).toBe(0);
    expect(good?.structuralConformance).toBe(1);
    expect(bad?.structuralConformance).toBe(0);
    expect((good?.score ?? 0) > (bad?.score ?? 0)).toBe(true);
  });

  it("runs each provider N times", async () => {
    const selector = new ModelSelector({ executor: makeExecutor() });
    const report = await selector.select({
      pipelineId: "selftest",
      input: "x",
      providers: ["good", "bad"],
      runs: 5,
    });
    expect(report.runsPerProvider).toBe(5);
    for (const p of report.providers) expect(p.runs).toBe(5);
  });

  it("honors configurable weights (merging over defaults)", async () => {
    const selector = new ModelSelector({ executor: makeExecutor() });
    const report = await selector.select({
      pipelineId: "selftest",
      input: "x",
      providers: ["good", "bad"],
      runs: 2,
      // Weight cost only — "good" is deterministically cheaper (0.001 vs 0.05),
      // so it must win regardless of wall-clock latency noise.
      weights: { cost: 1, latency: 0, validation: 0, conformance: 0 },
    });
    expect(report.weights.cost).toBe(1);
    expect(report.weights.latency).toBe(0);
    expect(report.recommendation).toBe("good");
  });

  it("defaults are applied when weights are omitted", async () => {
    const selector = new ModelSelector({ executor: makeExecutor() });
    const report = await selector.select({
      pipelineId: "selftest",
      input: "x",
      providers: ["good"],
      runs: 1,
    });
    expect(report.weights).toEqual(DEFAULT_WEIGHTS);
  });

  it("renders a ranked ASCII report with a recommendation", async () => {
    const selector = new ModelSelector({ executor: makeExecutor() });
    const report = await selector.select({
      pipelineId: "selftest",
      input: "x",
      providers: ["good", "bad"],
      runs: 2,
    });
    const table = renderSelectionTable(report);
    expect(table).toContain("Model selection for pipeline");
    expect(table).toContain("Recommendation: good");
    expect(table).toContain("valid_rate");
  });
});
