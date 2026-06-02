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
  storeDir = await mkdtemp(join(tmpdir(), "llmpk-p4-"));
  store = new FilesystemResultStore(storeDir);
  const registry = new FilesystemPromptRegistry(examplesRoot);
  const providers = new ProviderRegistry().register(new MockProvider());
  executor = new PipelineExecutor({ registry, providers, store });
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("S12 — dissent & red_team channel templates", () => {
  it("runs swot_recursive_dissent end-to-end; dissent channel validates", async () => {
    const result = await executor.run({
      pipelineId: "swot_recursive_dissent",
      input: "Evaluate releasing the kernel as open source.",
      options: { providers: ["mock"], depth: 1 },
    });
    expect(result.status).toBe("completed");
    expect(result.validation.valid).toBe(true);

    const ids = result.channels.map((c) => c.channelId).sort();
    expect(ids).toEqual(["dissent", "opportunities", "strengths", "threats", "weaknesses"]);

    const dissent = result.channels.find((c) => c.channelId === "dissent");
    expect(dissent?.schemaValid).toBe(true);
    // The dissent output conforms to its schema (objections array present).
    const parsed = dissent?.parsedOutput as { objections?: unknown[] } | undefined;
    expect(Array.isArray(parsed?.objections)).toBe(true);
    expect(result.synthesis?.schemaValid).toBe(true);
  });

  it("runs steelman_redteam end-to-end; steelman + red_team validate", async () => {
    const result = await executor.run({
      pipelineId: "steelman_redteam",
      input: "Evaluate adopting a microservices architecture.",
      options: { providers: ["mock"], depth: 1 },
    });
    expect(result.status).toBe("completed");
    expect(result.validation.valid).toBe(true);

    const ids = result.channels.map((c) => c.channelId).sort();
    expect(ids).toEqual(["red_team", "steelman"]);

    const steelman = result.channels.find((c) => c.channelId === "steelman");
    const redTeam = result.channels.find((c) => c.channelId === "red_team");
    expect(steelman?.schemaValid).toBe(true);
    expect(redTeam?.schemaValid).toBe(true);
    const rt = redTeam?.parsedOutput as { attacks?: unknown[] } | undefined;
    expect(Array.isArray(rt?.attacks)).toBe(true);
    expect(result.synthesis?.schemaValid).toBe(true);
  });
});
