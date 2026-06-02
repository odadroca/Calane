import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  JsonSchemaValidator,
  PipelineExecutor,
  type PromptRegistryInterface,
  ProviderRegistry,
  type ResolvedPipeline,
  canonicalJson,
  parsePipeline,
  sha256,
} from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

/**
 * Test registry: delegates prompt/schema loading to a filesystem registry rooted
 * at `examples/`, but resolves the eval pipeline from a nested path. This proves
 * the eval pipeline is an ordinary pipeline using existing primitives — it does
 * NOT add any new abstraction to the kernel; it only points the resolver at a
 * file the flat `examples/pipelines/` lister does not auto-discover.
 */
class NestedRegistry implements PromptRegistryInterface {
  readonly name = "nested";
  private fs = new FilesystemPromptRegistry(examplesRoot);
  constructor(private specYaml: string) {}
  async listPipelines(): Promise<string[]> {
    return [parsePipeline(this.specYaml).id];
  }
  async resolvePipeline(): Promise<ResolvedPipeline> {
    const spec = parsePipeline(this.specYaml);
    return {
      spec,
      registry: this.name,
      ref: null,
      commitSha: null,
      pipelineHash: `sha256:${sha256(canonicalJson(spec))}`,
    };
  }
  loadPrompt(p: string): Promise<string> {
    return this.fs.loadPrompt(p);
  }
  loadSchema(p: string): Promise<unknown> {
    return this.fs.loadSchema(p);
  }
}

let storeDir: string;
let store: FilesystemResultStore;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "llmpk-eval-"));
  store = new FilesystemResultStore(storeDir);
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("S16 — evaluation pipelines (pattern, not feature)", () => {
  it("scores a SWOT run; eval output validates against the evaluation schema", async () => {
    const providers = new ProviderRegistry().register(new MockProvider());

    // 1. Run the SWOT pipeline.
    const swotRegistry = new FilesystemPromptRegistry(examplesRoot);
    const swotExecutor = new PipelineExecutor({ registry: swotRegistry, providers, store });
    const swotRun = await swotExecutor.run({
      pipelineId: "swot_recursive",
      input: "Evaluate releasing the kernel as open source.",
      options: { providers: ["mock"], depth: 1 },
    });
    expect(swotRun.status).toBe("completed");

    // 2. Read the SWOT run back (its bundle/result) and feed it to the eval
    //    pipeline as input. The eval pipeline reads the prior run from {{input}}.
    const priorRun = await store.getRun(swotRun.runId);
    expect(priorRun).not.toBeNull();
    const evalInput = JSON.stringify(priorRun);

    // 3. Run the eval pipeline (resolved from its nested path).
    const evalYaml = await readFile(
      join(examplesRoot, "pipelines/eval/swot_eval.pipeline.yaml"),
      "utf8",
    );
    const evalRegistry = new NestedRegistry(evalYaml);
    const evalExecutor = new PipelineExecutor({ registry: evalRegistry, providers, store });
    const evalRun = await evalExecutor.run({
      pipelineId: "swot_eval",
      input: evalInput,
      options: { providers: ["mock"], depth: 1 },
    });

    expect(evalRun.status).toBe("completed");
    const scoreChannel = evalRun.channels.find((c) => c.channelId === "score");
    expect(scoreChannel?.schemaValid).toBe(true);
    const out = scoreChannel?.parsedOutput as
      | { dimensions?: unknown[]; overall?: number }
      | undefined;
    expect(Array.isArray(out?.dimensions)).toBe(true);
    expect(typeof out?.overall).toBe("number");
  });

  it("the evaluation schema validates a hand-authored dimension-scored output", async () => {
    const schema = parseYaml(
      await readFile(join(examplesRoot, "schemas/eval/evaluation.schema.json"), "utf8"),
    );
    const example = {
      dimensions: [
        { name: "completeness", score: 0.9, rationale: "All four SWOT dimensions present." },
        { name: "coherence", score: 0.7, rationale: "Recommendations track the channels." },
        { name: "evidence quality", score: 0.6, rationale: "Some claims lack evidence." },
        { name: "schema validity", score: 1, rationale: "All channels validated." },
        { name: "dissent depth", score: 0.3, rationale: "No dissent channel was run." },
      ],
      overall: 0.7,
    };
    const res = new JsonSchemaValidator().parseAndValidate(JSON.stringify(example), schema);
    expect(res.outcome).toBe("valid");
  });
});
