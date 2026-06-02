import {
  type ChannelResult,
  type RunResult,
  costStats,
  failureStats,
  latencyStats,
  renderCostTable,
  renderFailureTable,
  renderLatencyTable,
  statsUnsupportedError,
} from "@llm-pipe/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteResultStore } from "../src/SqliteResultStore.js";

function channel(over: Partial<ChannelResult> = {}): ChannelResult {
  return {
    channelId: "strengths",
    executionMode: "direct_provider",
    provider: "mock",
    model: "mock-model-1",
    status: "ok",
    latencyMs: 100,
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.001 },
    rawOutputRef: null,
    parsedOutput: { items: ["a"] },
    schemaValid: true,
    validationErrors: [],
    metadata: {},
    ...over,
  };
}

function makeRun(i: number): RunResult {
  // Three pipelines, two providers, varied statuses across a 5-day window.
  const pipelineId = ["swot", "steelman", "eval"][i % 3] as string;
  const provider = i % 2 === 0 ? "mock" : "openai";
  const day = 20 + (i % 5); // 2026-05-20 .. 2026-05-24
  const invalid = i % 7 === 0; // ~1 in 7 runs is invalid
  const failedChannel = i % 5 === 0; // a recurring failing channel
  return {
    runId: `run_${String(i).padStart(4, "0")}`,
    pipelineId,
    status: invalid ? "partial" : "completed",
    startedAt: `2026-05-${day}T10:00:00.000Z`,
    completedAt: `2026-05-${day}T10:00:05.000Z`,
    input: "topic",
    source: {
      registry: "filesystem",
      ref: null,
      commitSha: null,
      pipelineHash: `sha256:${pipelineId}`,
      promptHashes: {},
      schemaHashes: {},
    },
    providers: [provider],
    recursion: { enabled: false, maxDepth: 1, currentDepth: 1, carryForwardStrategy: null },
    channels: [
      channel({
        channelId: "strengths",
        provider,
        latencyMs: provider === "openai" ? 200 + i : 50 + i,
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.002 },
      }),
      channel({
        channelId: "weaknesses",
        provider,
        latencyMs: provider === "openai" ? 220 : 60,
        status: failedChannel ? "schema_error" : "ok",
        schemaValid: !failedChannel,
        usage: { inputTokens: 5, outputTokens: 10, costUsd: 0.001 },
      }),
    ],
    synthesis: null,
    resumedFrom: null,
    policy: [],
    validation: { valid: !invalid, errors: invalid ? [{ channelId: "weaknesses" }] : [] },
    telemetry: { traceId: null },
    artifacts: { bundlePath: null },
  };
}

describe("StatsQueries over a seeded SQLite corpus (~50 runs)", () => {
  let store: SqliteResultStore;
  let runs: RunResult[];

  beforeEach(async () => {
    store = new SqliteResultStore(":memory:");
    runs = [];
    for (let i = 0; i < 50; i++) {
      const r = makeRun(i);
      runs.push(r);
      await store.saveRun(r);
    }
  });

  afterEach(() => store.close());

  async function loadAll(): Promise<RunResult[]> {
    const ids = await store.listRuns();
    const out: RunResult[] = [];
    for (const id of ids) {
      const r = await store.getRun(id);
      if (r) out.push(r);
    }
    return out;
  }

  it("seeds 50 runs into the SQLite store", async () => {
    expect((await store.listRuns()).length).toBe(50);
  });

  it("cost stats: buckets by day and totals across the corpus", async () => {
    const all = await loadAll();
    const stats = costStats(all);
    expect(stats.totalRuns).toBe(50);
    // Each run has 0.002 + 0.001 = 0.003 cost; 50 runs => 0.15.
    expect(stats.totalCostUsd).toBeCloseTo(0.15, 6);
    expect(stats.buckets.length).toBe(5); // five distinct days
    const summed = stats.buckets.reduce((s, b) => s + b.runs, 0);
    expect(summed).toBe(50);
  });

  it("cost stats: filters by pipeline", async () => {
    const all = await loadAll();
    const stats = costStats(all, { pipelineId: "swot" });
    const expectedSwot = runs.filter((r) => r.pipelineId === "swot").length;
    expect(stats.totalRuns).toBe(expectedSwot);
    expect(stats.pipelineId).toBe("swot");
  });

  it("latency stats: aggregates per provider with mean/min/max", async () => {
    const all = await loadAll();
    const stats = latencyStats(all);
    const providers = stats.providers.map((p) => p.provider).sort();
    expect(providers).toEqual(["mock", "openai"]);
    const openai = stats.providers.find((p) => p.provider === "openai");
    const mock = stats.providers.find((p) => p.provider === "mock");
    // openai latencies are seeded higher than mock.
    expect(openai && mock && openai.meanLatencyMs > mock.meanLatencyMs).toBe(true);
    expect(openai?.minLatencyMs).toBeLessThanOrEqual(openai?.maxLatencyMs ?? 0);
  });

  it("latency stats: filters by provider", async () => {
    const all = await loadAll();
    const stats = latencyStats(all, { provider: "openai" });
    expect(stats.providers.length).toBe(1);
    expect(stats.providers[0]?.provider).toBe("openai");
  });

  it("failure stats: failure rate by pipeline and top failed channels", async () => {
    const all = await loadAll();
    const stats = failureStats(all);
    const totalInvalid = runs.filter((r) => !r.validation.valid).length;
    const summedInvalid = stats.byPipeline.reduce((s, p) => s + p.invalidRuns, 0);
    expect(summedInvalid).toBe(totalInvalid);
    // The recurring failing channel is "weaknesses".
    expect(stats.topFailedChannels[0]?.channelId).toBe("weaknesses");
    expect(stats.topFailedChannels[0]?.failures).toBeGreaterThan(0);
  });

  it("range filter narrows the corpus", async () => {
    const all = await loadAll();
    const narrowed = costStats(all, { range: { after: "2026-05-23T00:00:00.000Z" } });
    expect(narrowed.totalRuns).toBeLessThan(50);
    expect(narrowed.totalRuns).toBeGreaterThan(0);
  });

  it("renders ASCII tables (no table library)", async () => {
    const all = await loadAll();
    expect(renderCostTable(costStats(all))).toContain("cost_usd");
    expect(renderLatencyTable(latencyStats(all))).toMatch(/mock|openai/);
    const fail = renderFailureTable(failureStats(all));
    expect(fail).toContain("Top failed channels");
    expect(fail).toContain("fail_pct");
  });
});

describe("stats refuse on non-SQLite store", () => {
  it("statsUnsupportedError carries a clear structured message", () => {
    const err = statsUnsupportedError("filesystem");
    expect(err.code).toBe("stats_requires_sqlite");
    expect(err.storeName).toBe("filesystem");
    expect(err.error).toMatch(/SQLite/);
  });
});
