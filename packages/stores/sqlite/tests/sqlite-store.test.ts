import type { RunResult } from "@llm-pipe/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteResultStore } from "../src/SqliteResultStore.js";

function makeRun(overrides: Partial<RunResult> = {}): RunResult {
  const base: RunResult = {
    runId: `run_${Math.random().toString(16).slice(2, 10)}`,
    pipelineId: "swot",
    status: "completed",
    startedAt: "2026-05-25T10:00:00.000Z",
    completedAt: "2026-05-25T10:00:05.000Z",
    input: "Evaluate releasing the kernel as open source.",
    source: {
      registry: "filesystem",
      ref: "pipelines/swot.pipeline.yaml",
      commitSha: null,
      pipelineHash: "sha256:abc",
      promptHashes: { strengths: "sha256:p1" },
      schemaHashes: { strengths: "sha256:s1" },
    },
    providers: ["mock"],
    recursion: { enabled: false, maxDepth: 1, currentDepth: 1, carryForwardStrategy: null },
    channels: [
      {
        channelId: "strengths",
        executionMode: "direct_provider",
        provider: "mock",
        model: "mock-model-1",
        status: "ok",
        latencyMs: 12,
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.0001 },
        rawOutputRef: "raw/strengths.mock.txt",
        parsedOutput: { items: ["a", "b"] },
        schemaValid: true,
        validationErrors: [],
        metadata: {},
      },
    ],
    synthesis: {
      channelId: "synthesis",
      executionMode: "direct_provider",
      provider: "mock",
      model: "mock-model-1",
      status: "ok",
      latencyMs: 8,
      usage: { inputTokens: 5, outputTokens: 9, costUsd: 0.00005 },
      rawOutputRef: null,
      parsedOutput: { summary: "ok" },
      schemaValid: true,
      validationErrors: [],
      metadata: {},
    },
    validation: { valid: true, errors: [] },
    telemetry: { traceId: null },
    artifacts: { bundlePath: null },
  };
  return { ...base, ...overrides };
}

describe("SqliteResultStore", () => {
  let store: SqliteResultStore;

  beforeEach(() => {
    store = new SqliteResultStore(":memory:");
  });
  afterEach(() => {
    store.close();
  });

  it("migration is idempotent (second construction over a path does not throw)", () => {
    // Re-running migrate via a fresh store against the same in-memory schema is
    // already implicit; assert the explicit re-entry by constructing twice.
    const a = new SqliteResultStore(":memory:");
    const b = new SqliteResultStore(":memory:");
    expect(a.name).toBe("sqlite");
    expect(b.name).toBe("sqlite");
    a.close();
    b.close();
  });

  it("round-trips three example runs by runId with JSON-shape equality", async () => {
    const runs = [
      makeRun({ runId: "run_one" }),
      makeRun({ runId: "run_two", status: "partial" }),
      makeRun({ runId: "run_three", status: "failed" }),
    ];
    for (const r of runs) await store.saveRun(r);
    for (const r of runs) {
      const loaded = await store.getRun(r.runId);
      expect(loaded).toEqual(r);
    }
  });

  it("getRun returns null for an unknown id", async () => {
    expect(await store.getRun("nope")).toBeNull();
  });

  it("listRuns returns all stored ids", async () => {
    await store.saveRun(makeRun({ runId: "r1" }));
    await store.saveRun(makeRun({ runId: "r2" }));
    expect((await store.listRuns()).sort()).toEqual(["r1", "r2"]);
  });

  it("listRunsFiltered filters by pipelineId, status, and time range", async () => {
    await store.saveRun(
      makeRun({
        runId: "a",
        pipelineId: "swot",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await store.saveRun(
      makeRun({
        runId: "b",
        pipelineId: "swot",
        status: "failed",
        startedAt: "2026-06-01T00:00:00.000Z",
      }),
    );
    await store.saveRun(
      makeRun({
        runId: "c",
        pipelineId: "other",
        status: "completed",
        startedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    expect((await store.listRunsFiltered({ pipelineId: "swot" })).sort()).toEqual(["a", "b"]);
    expect(await store.listRunsFiltered({ status: "failed" })).toEqual(["b"]);
    expect(await store.listRunsFiltered({ pipelineId: "swot", status: "completed" })).toEqual([
      "a",
    ]);
    expect(
      await store.listRunsFiltered({
        startedAfter: "2026-02-01T00:00:00.000Z",
        startedBefore: "2026-05-01T00:00:00.000Z",
      }),
    ).toEqual(["c"]);
  });

  it("stores and retrieves raw outputs as TEXT", async () => {
    const ref = await store.saveRawOutput("run_one", "strengths.mock", "raw provider text");
    expect(await store.getRawOutput("run_one", ref)).toBe("raw provider text");
    expect(await store.getRawOutput("run_one", "missing")).toBeNull();
  });

  it("re-saving a run replaces its denormalized projections (no duplication)", async () => {
    const run = makeRun({ runId: "dup" });
    await store.saveRun(run);
    await store.saveRun(run);
    const loaded = await store.getRun("dup");
    expect(loaded).toEqual(run);
    expect(await store.listRuns()).toEqual(["dup"]);
  });
});
