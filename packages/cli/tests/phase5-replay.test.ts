import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplayError, Replayer, RunBundleExporter } from "@llm-pipe/core";
import { ProviderRegistry } from "@llm-pipe/core";
import { PipelineExecutor } from "@llm-pipe/core";
import type { RunResult } from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

let storeDir: string;
let bundleRoot: string;
let store: FilesystemResultStore;
let registry: FilesystemPromptRegistry;
let executor: PipelineExecutor;
let exporter: RunBundleExporter;

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "replay-store-"));
  bundleRoot = await mkdtemp(join(tmpdir(), "replay-bundles-"));
  store = new FilesystemResultStore(storeDir);
  registry = new FilesystemPromptRegistry(examplesRoot);
  const providers = new ProviderRegistry().register(new MockProvider());
  executor = new PipelineExecutor({ registry, providers, store });
  exporter = new RunBundleExporter(store);
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
  await rm(bundleRoot, { recursive: true, force: true });
});

async function makeBundle(): Promise<{ original: RunResult; bundlePath: string }> {
  const original = await executor.run({
    pipelineId: "swot_recursive",
    input: "Evaluate releasing the kernel as open source.",
    options: { providers: ["mock"], depth: 1 },
  });
  const { bundlePath } = await exporter.export(original, { outDir: bundleRoot });
  return { original, bundlePath };
}

describe("Replayer (S19)", () => {
  it("replays a bundle with matching hashes, sets replayedFrom, and auto-diffs", async () => {
    const { original, bundlePath } = await makeBundle();
    const replayer = new Replayer({ registry, executor, store });
    const { originalRunId, replay, diff } = await replayer.replay(bundlePath, {
      providers: ["mock"],
    });
    expect(originalRunId).toBe(original.runId);
    expect(replay.replayedFrom).toBe(original.runId);
    expect(replay.runId).not.toBe(original.runId);
    expect(diff.comparable).toBe(true);
    expect(diff.pipelineId).toBe(original.pipelineId);
    // The mock provider is deterministic, so the replay should be identical.
    expect(diff.identical).toBe(true);
    const reloaded = await store.getRun(replay.runId);
    expect(reloaded?.replayedFrom).toBe(original.runId);
  });

  it("refuses replay when the pipeline hash differs", async () => {
    const { bundlePath } = await makeBundle();
    const manifestPath = join(bundlePath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.source.pipelineHash = "sha256:TAMPERED_PIPELINE";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const replayer = new Replayer({ registry, executor, store });
    try {
      await replayer.replay(bundlePath, { providers: ["mock"] });
      throw new Error("expected replay to be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ReplayError);
      const e = err as ReplayError;
      expect(e.code).toBe("hash_mismatch");
      expect(e.mismatches.some((m) => m.startsWith("pipelineHash:"))).toBe(true);
    }
  });

  it("refuses replay when a prompt hash differs", async () => {
    const { bundlePath } = await makeBundle();
    const manifestPath = join(bundlePath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const firstChannel = Object.keys(manifest.source.promptHashes)[0];
    manifest.source.promptHashes[firstChannel] = "sha256:TAMPERED_PROMPT";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const replayer = new Replayer({ registry, executor, store });
    try {
      await replayer.replay(bundlePath, { providers: ["mock"] });
      throw new Error("expected replay to be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ReplayError);
      const e = err as ReplayError;
      expect(e.code).toBe("hash_mismatch");
      expect(e.mismatches.some((m) => m.startsWith(`promptHash[${firstChannel}]:`))).toBe(true);
    }
  });

  it("refuses replay when the bundle is unreadable", async () => {
    const replayer = new Replayer({ registry, executor, store });
    try {
      await replayer.replay(join(bundleRoot, "does-not-exist"), { providers: ["mock"] });
      throw new Error("expected replay to be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ReplayError);
      expect((err as ReplayError).code).toBe("bundle_unreadable");
    }
  });
});
