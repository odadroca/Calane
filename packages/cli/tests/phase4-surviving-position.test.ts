import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonSchemaValidator, PipelineExecutor, ProviderRegistry } from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

let storeDir: string;
let store: FilesystemResultStore;
let executor: PipelineExecutor;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "llmpk-sp-"));
  store = new FilesystemResultStore(storeDir);
  const registry = new FilesystemPromptRegistry(examplesRoot);
  const providers = new ProviderRegistry().register(new MockProvider());
  executor = new PipelineExecutor({ registry, providers, store });
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("S13 — surviving-position synthesis", () => {
  it("runs the surviving_position pipeline; synthesis validates against schema", async () => {
    const result = await executor.run({
      pipelineId: "surviving_position",
      input: "Evaluate adopting an event-driven architecture.",
      options: { providers: ["mock"], depth: 1 },
    });
    expect(result.status).toBe("completed");
    expect(result.synthesis?.channelId).toBe("synthesis");
    expect(result.synthesis?.schemaValid).toBe(true);
    const out = result.synthesis?.parsedOutput as { positions?: unknown[] } | undefined;
    expect(Array.isArray(out?.positions)).toBe(true);
  });

  it("a hand-authored surviving_position output validates against the schema", async () => {
    const schema = JSON.parse(
      await readFile(
        join(examplesRoot, "schemas/surviving_position.synthesis.schema.json"),
        "utf8",
      ),
    );
    const example = {
      positions: [
        {
          claim: "Open-sourcing the kernel grows adoption.",
          support: "Reduces integration friction for downstream teams.",
          dissent_responses: ["Maintenance burden is bounded by the 8-tool surface."],
          survives: true,
          confidence: 0.72,
        },
        {
          claim: "Open-sourcing immediately monetizes the project.",
          support: "Visibility could attract sponsors.",
          dissent_responses: ["No billing path exists; this conflates adoption with revenue."],
          survives: false,
          confidence: 0.2,
        },
      ],
      summary: "One position survives; the monetization claim does not.",
    };
    const res = new JsonSchemaValidator().parseAndValidate(JSON.stringify(example), schema);
    expect(res.outcome).toBe("valid");
  });
});
