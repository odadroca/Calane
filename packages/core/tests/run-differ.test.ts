import { describe, expect, it } from "vitest";
import {
  RunDiffError,
  diffParsed,
  diffRuns,
  renderDiffMarkdown,
  tryDiffRuns,
} from "../src/diff/RunDiffer.js";
import type { ChannelResult, RunResult } from "../src/specs/RunResult.js";

function channel(over: Partial<ChannelResult> = {}): ChannelResult {
  return {
    channelId: "strengths",
    executionMode: "direct_provider",
    provider: "mock",
    model: "mock-model-1",
    status: "ok",
    latencyMs: 100,
    usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
    rawOutputRef: null,
    parsedOutput: { items: ["a", "b"], score: 3 },
    schemaValid: true,
    validationErrors: [],
    metadata: {},
    ...over,
  };
}

function run(over: Partial<RunResult> = {}, channels?: ChannelResult[]): RunResult {
  return {
    runId: "run_a",
    pipelineId: "swot",
    status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    input: "topic",
    source: {
      registry: "filesystem",
      ref: null,
      commitSha: null,
      pipelineHash: "sha256:PIPELINE_A",
      promptHashes: {},
      schemaHashes: {},
    },
    providers: ["mock"],
    recursion: { enabled: false, maxDepth: 1, currentDepth: 1, carryForwardStrategy: null },
    channels: channels ?? [channel()],
    synthesis: null,
    resumedFrom: null,
    policy: [],
    validation: { valid: true, errors: [] },
    telemetry: { traceId: null },
    artifacts: { bundlePath: null },
    ...over,
  };
}

describe("diffParsed (schema-aware key-level diff)", () => {
  it("reports added, removed, and changed leaves by path", () => {
    const a = { keep: 1, drop: 2, num: 3, arr: [1, 2] };
    const b = { keep: 1, num: 4, add: 9, arr: [1, 2, 3] };
    const changes = diffParsed(a, b);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.kind]));
    expect(byPath.drop).toBe("removed");
    expect(byPath.add).toBe("added");
    expect(byPath.num).toBe("changed");
    expect(byPath["arr[2]"]).toBe("added");
    expect(byPath.keep).toBeUndefined();
  });
});

describe("diffRuns — three fixture pairs", () => {
  it("identical runs diff to identical:true with no channel changes", () => {
    const a = run({ runId: "run_a" });
    const b = run({ runId: "run_b" });
    const diff = diffRuns(a, b);
    expect(diff.comparable).toBe(true);
    expect(diff.identical).toBe(true);
    expect(diff.status.changed).toBe(false);
    const ch = diff.channels.find((c) => c.channelId === "strengths");
    expect(ch?.presence).toBe("both");
    expect(ch?.fields?.parsedChanges).toHaveLength(0);
  });

  it("status-different runs flag the status/validation change", () => {
    const a = run({ runId: "run_a" });
    const b = run(
      {
        runId: "run_b",
        status: "partial",
        validation: { valid: false, errors: [{ channelId: "strengths" }] },
      },
      [channel({ status: "schema_error", schemaValid: false })],
    );
    const diff = diffRuns(a, b);
    expect(diff.identical).toBe(false);
    expect(diff.status.changed).toBe(true);
    expect(diff.validationValid.changed).toBe(true);
    const ch = diff.channels.find((c) => c.channelId === "strengths");
    expect(ch?.fields?.status.changed).toBe(true);
    expect(ch?.fields?.schemaValid.changed).toBe(true);
  });

  it("content-different runs report key-level parsed changes and cost/latency deltas", () => {
    const a = run({ runId: "run_a" });
    const b = run({ runId: "run_b" }, [
      channel({
        parsedOutput: { items: ["a", "c"], score: 5 },
        usage: { inputTokens: 10, outputTokens: 20, costUsd: 0.03 },
        latencyMs: 250,
      }),
    ]);
    const diff = diffRuns(a, b);
    expect(diff.identical).toBe(false);
    const ch = diff.channels.find((c) => c.channelId === "strengths");
    const paths = ch?.fields?.parsedChanges.map((c) => c.path).sort();
    expect(paths).toContain("items[1]");
    expect(paths).toContain("score");
    expect(ch?.fields?.costUsd.delta).toBeCloseTo(0.02);
    expect(ch?.fields?.latencyMs.delta).toBe(150);
    expect(diff.totalCostUsd.delta).toBeCloseTo(0.02);
  });
});

describe("diffRuns — presence and refusal", () => {
  it("flags channels present in only one run", () => {
    const a = run({ runId: "run_a" }, [channel({ channelId: "strengths" })]);
    const b = run({ runId: "run_b" }, [
      channel({ channelId: "strengths" }),
      channel({ channelId: "weaknesses" }),
    ]);
    const diff = diffRuns(a, b);
    const extra = diff.channels.find((c) => c.channelId === "weaknesses");
    expect(extra?.presence).toBe("only_b");
    expect(diff.identical).toBe(false);
  });

  it("refuses to diff runs of different pipelines (different pipelineHash)", () => {
    const a = run({ runId: "run_a" });
    const b = run({
      runId: "run_b",
      source: { ...run().source, pipelineHash: "sha256:PIPELINE_B" },
    });
    expect(() => diffRuns(a, b)).toThrow(RunDiffError);
    const lenient = tryDiffRuns(a, b);
    expect(lenient.comparable).toBe(false);
    expect(lenient.reason).toMatch(/different pipeline/i);
  });
});

describe("renderDiffMarkdown", () => {
  it("renders a human-readable markdown report", () => {
    const a = run({ runId: "run_a" });
    const b = run({ runId: "run_b" }, [channel({ parsedOutput: { items: ["a", "z"], score: 9 } })]);
    const md = renderDiffMarkdown(diffRuns(a, b));
    expect(md).toContain("# Run diff: run_a vs run_b");
    expect(md).toContain("Parsed output changes:");
    expect(md).toContain("score");
  });

  it("renders a refusal for non-comparable runs", () => {
    const a = run({ runId: "run_a" });
    const b = run({
      runId: "run_b",
      source: { ...run().source, pipelineHash: "sha256:PIPELINE_B" },
    });
    const md = renderDiffMarkdown(tryDiffRuns(a, b));
    expect(md).toContain("Not comparable");
  });
});
