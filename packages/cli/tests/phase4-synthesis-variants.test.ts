import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PipelineExecutor, ProviderRegistry } from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

let storeDir: string;
let store: FilesystemResultStore;
let executor: PipelineExecutor;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "llmpk-sv-"));
  store = new FilesystemResultStore(storeDir);
  const registry = new FilesystemPromptRegistry(examplesRoot);
  const providers = new ProviderRegistry().register(new MockProvider());
  executor = new PipelineExecutor({ registry, providers, store });
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("S15 — synthesis variants", () => {
  const cases = [
    "synthesis_consensus",
    "synthesis_steelman",
    "synthesis_adversarial",
    "synthesis_weighted",
  ] as const;

  for (const pipelineId of cases) {
    it(`${pipelineId} runs end-to-end and its synthesis validates against the variant schema`, async () => {
      const result = await executor.run({
        pipelineId,
        input: "Evaluate releasing the kernel as open source.",
        options: { providers: ["mock"], depth: 1 },
      });
      expect(result.status).toBe("completed");
      expect(result.synthesis?.channelId).toBe("synthesis");
      expect(result.synthesis?.schemaValid).toBe(true);
      const out = result.synthesis?.parsedOutput as
        | { summary?: string; recommendations?: unknown[] }
        | undefined;
      expect(typeof out?.summary).toBe("string");
      expect(Array.isArray(out?.recommendations)).toBe(true);
    });
  }
});
