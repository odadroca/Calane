import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ResumeError,
  RunBundleExporter,
  type RunResult,
} from "../src/index.js";
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

class OkProvider implements ProviderAdapterInterface {
  readonly type = "ok";
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    return {
      rawOutput: JSON.stringify({ channel: request.channelId, ok: true }),
      model: "ok-1",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
  }
}

const SPEC: PipelineSpec = {
  id: "five",
  version: "0.1.0",
  providers: [{ id: "ok", type: "ok" }],
  channels: ["c1", "c2", "c3", "c4", "c5"].map((id) => ({
    id,
    executionMode: "direct_provider" as const,
    prompt: `prompts/${id}.md`,
  })),
};

class MemRegistry implements PromptRegistryInterface {
  readonly name = "mem";
  constructor(private spec: PipelineSpec = SPEC) {}
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
    return `prompt:${p}`;
  }
  async loadSchema(): Promise<unknown> {
    return { type: "object", additionalProperties: true };
  }
}

function pipelineHash(spec: PipelineSpec): string {
  return `sha256:${sha256(canonicalJson(spec))}`;
}

/** Build a partial prior run: c1,c2 ok; c3,c4,c5 failed. */
function makePartialRun(reg: MemRegistry, promptOverrides?: Record<string, string>): RunResult {
  const promptHashes: Record<string, string> = {};
  for (const id of ["c1", "c2", "c3", "c4", "c5"]) {
    promptHashes[id] = sha256(promptOverrides?.[id] ?? `prompt:prompts/${id}.md`);
  }
  const ch = (id: string, ok: boolean): RunResult["channels"][number] => ({
    channelId: id,
    executionMode: "direct_provider",
    provider: "ok",
    model: "ok-1",
    status: ok ? "ok" : "error",
    latencyMs: 1,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    rawOutputRef: ok ? `raw/${id}.ok.txt` : null,
    parsedOutput: ok ? { channel: id, ok: true } : null,
    schemaValid: ok,
    validationErrors: [],
    metadata: { providerId: "ok" },
  });
  return {
    runId: "prior_run_1",
    pipelineId: "five",
    status: "partial",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    input: "the topic",
    source: {
      registry: "mem",
      ref: null,
      commitSha: null,
      pipelineHash: pipelineHash(SPEC),
      promptHashes,
      schemaHashes: {},
    },
    providers: ["ok"],
    recursion: { enabled: false, maxDepth: 1, currentDepth: 1, carryForwardStrategy: null },
    channels: [ch("c1", true), ch("c2", true), ch("c3", false), ch("c4", false), ch("c5", false)],
    synthesis: null,
    resumedFrom: null,
    policy: [],
    validation: { valid: false, errors: [] },
    telemetry: { traceId: null },
    artifacts: { bundlePath: null },
  };
}

function makeExecutor(reg: MemRegistry, store: MemStore) {
  return new PipelineExecutor({
    registry: reg,
    providers: new ProviderRegistry().register(new OkProvider()),
    store,
  });
}

describe("partial-run recovery (S9)", () => {
  it("resumes a partial run: carries forward c1/c2, re-runs c3/c4/c5", async () => {
    const reg = new MemRegistry();
    const store = new MemStore();
    const prior = makePartialRun(reg);
    await store.saveRun(prior);
    const executor = makeExecutor(reg, store);

    const resumed = await executor.resume("prior_run_1");

    expect(resumed.resumedFrom).toBe("prior_run_1");
    expect(resumed.runId).not.toBe("prior_run_1");
    expect(resumed.channels.map((c) => c.channelId).sort()).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    // c1/c2 carried forward unchanged (same parsedOutput, status ok).
    const c1 = resumed.channels.find((c) => c.channelId === "c1");
    expect(c1?.status).toBe("ok");
    // c3/c4/c5 now succeeded.
    for (const id of ["c3", "c4", "c5"]) {
      expect(resumed.channels.find((c) => c.channelId === id)?.status).toBe("ok");
    }
    expect(resumed.status).toBe("completed");
  });

  it("carries forward completed channel results unchanged", async () => {
    const reg = new MemRegistry();
    const store = new MemStore();
    const prior = makePartialRun(reg);
    await store.saveRun(prior);
    const executor = makeExecutor(reg, store);

    const resumed = await executor.resume("prior_run_1");
    const priorC1 = prior.channels.find((c) => c.channelId === "c1");
    const newC1 = resumed.channels.find((c) => c.channelId === "c1");
    expect(newC1).toEqual(priorC1);
  });

  it("exports a bundle with all 5 channels and resumedFrom populated", async () => {
    const reg = new MemRegistry();
    const store = new MemStore();
    await store.saveRun(makePartialRun(reg));
    const executor = makeExecutor(reg, store);
    const resumed = await executor.resume("prior_run_1");

    const out = await mkdtemp(join(tmpdir(), "resume-bundle-"));
    try {
      const exporter = new RunBundleExporter(store);
      const { bundlePath } = await exporter.export(resumed, { outDir: out });
      const manifest = JSON.parse(await readFile(join(bundlePath, "manifest.json"), "utf8"));
      expect(manifest.channels).toHaveLength(5);
      // resumedFrom is on the RunResult itself.
      expect(resumed.resumedFrom).toBe("prior_run_1");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("refuses to resume when the run does not exist", async () => {
    const reg = new MemRegistry();
    const store = new MemStore();
    const executor = makeExecutor(reg, store);
    await expect(executor.resume("nope")).rejects.toMatchObject({
      name: "ResumeError",
      code: "run_not_found",
    });
  });

  it("refuses to resume on a pipeline/prompt hash mismatch", async () => {
    const reg = new MemRegistry();
    const store = new MemStore();
    // Prior run recorded a different prompt hash for c3 → definition changed.
    const prior = makePartialRun(reg, { c3: "prompt:prompts/c3-OLD.md" });
    await store.saveRun(prior);
    const executor = makeExecutor(reg, store);

    let caught: ResumeError | null = null;
    try {
      await executor.resume("prior_run_1");
    } catch (err) {
      caught = err as ResumeError;
    }
    expect(caught).toBeInstanceOf(ResumeError);
    expect(caught?.code).toBe("hash_mismatch");
    expect(caught?.mismatches.some((m) => m.includes("promptHash[c3]"))).toBe(true);
  });

  it("routes run() with options.resumeFromRunId through resume()", async () => {
    const reg = new MemRegistry();
    const store = new MemStore();
    await store.saveRun(makePartialRun(reg));
    const executor = makeExecutor(reg, store);

    const resumed = await executor.run({
      pipelineId: "five",
      input: "ignored — taken from prior run",
      options: { resumeFromRunId: "prior_run_1" },
    });
    expect(resumed.resumedFrom).toBe("prior_run_1");
    expect(resumed.input).toBe("the topic"); // carried from prior run
    expect(resumed.channels).toHaveLength(5);
  });
});
