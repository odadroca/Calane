import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JsonSchemaValidator,
  PipelineExecutor,
  PromptRenderer,
  ProviderRegistry,
  RunBundleExporter,
  executeChannel,
} from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

let storeDir: string;
let store: FilesystemResultStore;
let executor: PipelineExecutor;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "llmpk-"));
  store = new FilesystemResultStore(storeDir);
  const registry = new FilesystemPromptRegistry(examplesRoot);
  const providers = new ProviderRegistry().register(new MockProvider());
  executor = new PipelineExecutor({ registry, providers, store });
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("PipelineExecutor end-to-end (mock)", () => {
  it("runs the SWOT pipeline to a valid, completed run", async () => {
    const result = await executor.run({
      pipelineId: "swot_recursive",
      input: "Evaluate releasing the kernel as open source.",
      options: { providers: ["mock"], depth: 1 },
    });
    expect(result.status).toBe("completed");
    expect(result.validation.valid).toBe(true);
    expect(result.channels.map((c) => c.channelId).sort()).toEqual([
      "opportunities",
      "strengths",
      "threats",
      "weaknesses",
    ]);
    expect(result.synthesis?.schemaValid).toBe(true);
    expect(result.source.pipelineHash).toMatch(/^sha256:/);
    expect(Object.keys(result.source.promptHashes)).toContain("strengths");
    expect(Object.keys(result.source.schemaHashes)).toContain("synthesis");
  });

  it("persists and reloads the run", async () => {
    const run = await executor.run({
      pipelineId: "swot_recursive",
      input: "topic",
      options: { providers: ["mock"], depth: 1 },
    });
    const loaded = await store.getRun(run.runId);
    expect(loaded?.runId).toBe(run.runId);
    expect(await store.listRuns()).toContain(run.runId);
  });

  it("exports a reproducible run bundle", async () => {
    const run = await executor.run({
      pipelineId: "swot_recursive",
      input: "topic",
      options: { providers: ["mock"], depth: 1 },
    });
    const out = await mkdtemp(join(tmpdir(), "bundle-"));
    const exporter = new RunBundleExporter(store);
    const { files } = await exporter.export(run, { outDir: out });
    expect(files).toContain("manifest.json");
    expect(files).toContain("final.md");
    expect(files.some((f) => f.startsWith("raw_outputs/"))).toBe(true);
    await rm(out, { recursive: true, force: true });
  });

  it("recurses up to maxDepth when enabled", async () => {
    const run = await executor.run({
      pipelineId: "swot_recursive",
      input: "topic",
      options: { providers: ["mock"], depth: 2 },
    });
    expect(run.recursion.currentDepth).toBe(2);
    // 4 channels per depth * 2 depths.
    expect(run.channels).toHaveLength(8);
  });
});

describe("invalid output handling (acceptance #9)", () => {
  it("marks invalid JSON as invalid and preserves the raw output", async () => {
    const planned = {
      channel: { id: "broken", executionMode: "direct_provider" as const, prompt: "ignored" },
      provider: { id: "mock", type: "mock", options: { mockMode: "invalid_json" } },
      isSynthesis: false,
    };
    const result = await executeChannel(planned, {
      adapter: new MockProvider(),
      renderer: new PromptRenderer(),
      validator: new JsonSchemaValidator(),
      store,
      runId: "run_invalidtest",
      promptTemplate: "say something",
      schema: { type: "object", required: ["a"], properties: { a: { type: "number" } } },
      context: { input: "x" },
    });
    expect(result.status).toBe("invalid_json");
    expect(result.schemaValid).toBe(false);
    expect(result.rawOutputRef).toBeTruthy();
    const raw = await store.getRawOutput("run_invalidtest", result.rawOutputRef!);
    expect(raw).toContain("not json");
  });
});
