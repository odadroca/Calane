import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ExternalRegistry,
  InstanceKeypair,
  ModelSelector,
  PipelineExecutor,
  ProviderRegistry,
  Replayer,
  RunBundleExporter,
  type RunResult,
  costStats,
  diffRuns,
  failureStats,
  isExternalReference,
  latencyStats,
  parseExternalReference,
  verifyBundleDir,
} from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { GitPromptRegistry } from "@llm-pipe/registry-git";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";
import { SqliteResultStore } from "@llm-pipe/store-sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKernel } from "../src/kernel.js";

/**
 * Executable companions to docs/scenarios/*. Each `describe` block mirrors one
 * documented end-to-end scenario, run offline against the deterministic mock
 * provider so the published walkthroughs cannot silently rot.
 */

const exec = promisify(execFile);
const examplesRoot = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples");

function freshExecutor(store: FilesystemResultStore | SqliteResultStore) {
  const registry = new FilesystemPromptRegistry(examplesRoot);
  const providers = new ProviderRegistry().register(new MockProvider());
  return new PipelineExecutor({ registry, providers, store });
}

const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

describe("scenario 01: run -> store -> export -> sign -> verify", () => {
  let storeDir: string;
  let bundleRoot: string;
  let keyDir: string;

  beforeAll(async () => {
    storeDir = await tmp("scen01-store-");
    bundleRoot = await tmp("scen01-bundle-");
    keyDir = await tmp("scen01-keys-");
  });
  afterAll(async () => {
    for (const d of [storeDir, bundleRoot, keyDir]) await rm(d, { recursive: true, force: true });
  });

  it("runs SWOT to a completed, valid run, then signs and verifies its bundle", async () => {
    const store = new FilesystemResultStore(storeDir);
    const executor = freshExecutor(store);
    const run = await executor.run({
      pipelineId: "swot_recursive",
      input: "Evaluate releasing the kernel as open source.",
      options: { providers: ["mock"], depth: 1 },
    });
    expect(run.status).toBe("completed");
    expect(run.validation.valid).toBe(true);

    // The run is retrievable by id and listed in the store.
    expect((await store.getRun(run.runId))?.runId).toBe(run.runId);
    expect(await store.listRuns()).toContain(run.runId);

    // Sign on export, then verify the detached signature + content hash.
    const keypair = new InstanceKeypair({ dir: keyDir }).ensure();
    const exporter = new RunBundleExporter(store);
    const exported = await exporter.export(run, { outDir: bundleRoot, keypair });
    const verdict = await verifyBundleDir(exported.bundlePath, keypair.publicKeyPem());
    expect(verdict.valid).toBe(true);
  });
});

describe("scenario 02: operational (diff, replay, stats)", () => {
  let storeDir: string;
  let bundleRoot: string;
  let sqlitePath: string;

  beforeAll(async () => {
    storeDir = await tmp("scen02-store-");
    bundleRoot = await tmp("scen02-bundle-");
    sqlitePath = join(await tmp("scen02-sqlite-"), "runs.sqlite");
  });
  afterAll(async () => {
    for (const d of [storeDir, bundleRoot]) await rm(d, { recursive: true, force: true });
  });

  it("diffs two runs of the same pipeline (comparable)", async () => {
    const executor = freshExecutor(new FilesystemResultStore(storeDir));
    const a = await executor.run({
      pipelineId: "swot_recursive",
      input: "Topic A",
      options: { providers: ["mock"], depth: 1 },
    });
    const b = await executor.run({
      pipelineId: "swot_recursive",
      input: "Topic B",
      options: { providers: ["mock"], depth: 1 },
    });
    const diff = diffRuns(a, b);
    expect(diff.comparable).toBe(true);
    expect(diff.pipelineId).toBe("swot_recursive");
  });

  it("replays an exported bundle to an identical run (deterministic mock)", async () => {
    const store = new FilesystemResultStore(storeDir);
    const registry = new FilesystemPromptRegistry(examplesRoot);
    const executor = freshExecutor(store);
    const original = await executor.run({
      pipelineId: "swot_recursive",
      input: "Replay me",
      options: { providers: ["mock"], depth: 1 },
    });
    const { bundlePath } = await new RunBundleExporter(store).export(original, {
      outDir: bundleRoot,
    });
    const replayer = new Replayer({ registry, executor, store });
    const { replay, diff } = await replayer.replay(bundlePath, { providers: ["mock"] });
    expect(replay.replayedFrom).toBe(original.runId);
    expect(diff.identical).toBe(true);
  });

  it("aggregates cross-run stats from the SQLite store", async () => {
    const store = new SqliteResultStore(sqlitePath);
    const executor = freshExecutor(store);
    await executor.run({
      pipelineId: "swot_recursive",
      input: "one",
      options: { providers: ["mock"], depth: 1 },
    });
    await executor.run({
      pipelineId: "swot_recursive",
      input: "two",
      options: { providers: ["mock"], depth: 1 },
    });
    const runs: RunResult[] = [];
    for (const id of await store.listRuns()) {
      const r = await store.getRun(id);
      if (r) runs.push(r);
    }
    expect(costStats(runs).totalRuns).toBe(2);
    expect(failureStats(runs).byPipeline.some((p) => p.pipelineId === "swot_recursive")).toBe(true);
    expect(latencyStats(runs).providers.some((p) => p.provider === "mock")).toBe(true);
  });
});

describe("scenario 04: rank providers with select-model", () => {
  it("produces a ranked report and a recommendation", async () => {
    const storeDir = await tmp("scen04-store-");
    try {
      const executor = freshExecutor(new FilesystemResultStore(storeDir));
      const report = await new ModelSelector({ executor }).select({
        pipelineId: "swot_recursive",
        input: "rank the providers",
        providers: ["mock"],
        runs: 2,
      });
      expect(report.recommendation).toBe("mock");
      expect(report.runsPerProvider).toBe(2);
      expect(report.providers).toHaveLength(1);
      expect(report.providers[0]?.provider).toBe("mock");
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});

describe("scenario 05a: connect an external registry over HTTPS", () => {
  const REF = "registry.example.org/acme/swot@v1.0.0";

  it("resolves a trusted external reference and runs it (read-only)", async () => {
    expect(isExternalReference(REF)).toBe(true);
    expect(parseExternalReference(REF).host).toBe("registry.example.org");

    const storeDir = await tmp("scen05a-store-");
    const cacheDir = await tmp("scen05a-cache-");
    try {
      // A pinned, in-process "registry host" serving the example SWOT spec; the
      // prompt/schema loads fall back to the local examples registry.
      const specText = await readFile(
        join(examplesRoot, "pipelines", "swot_recursive.pipeline.yaml"),
        "utf8",
      );
      const registry = new ExternalRegistry({
        base: new FilesystemPromptRegistry(examplesRoot),
        trustedHosts: ["registry.example.org"],
        cacheDir,
        fetchImpl: async (url: string) =>
          url.startsWith("https://registry.example.org/pipelines/acme/swot")
            ? { ok: true, status: 200, text: async () => specText }
            : { ok: false, status: 404, text: async () => "" },
      });
      const store = new FilesystemResultStore(storeDir);
      const providers = new ProviderRegistry().register(new MockProvider());
      const executor = new PipelineExecutor({ registry, providers, store });
      const run = await executor.run({
        pipelineId: REF,
        input: "topic",
        options: { providers: ["mock"], depth: 1 },
      });
      expect(run.status).toBe("completed");
      expect(run.source.registry).toBe("external");
      expect(run.source.ref).toBe(REF);
    } finally {
      for (const d of [storeDir, cacheDir]) await rm(d, { recursive: true, force: true });
    }
  });
});

describe("scenario 05b: connect a Git (e.g. GitHub) prompt registry", () => {
  let repoDir: string;
  let cacheRoot: string;
  let storeDir: string;
  let headSha: string;

  const pipelineYaml = `id: fixture_pipeline
version: 0.1.0
providers:
  - id: mock
    type: mock
channels:
  - id: analyze
    executionMode: direct_provider
    prompt: prompts/analyze.md
    outputSchema: schemas/out.schema.json
`;
  const schemaJson = JSON.stringify({
    type: "object",
    required: ["summary"],
    additionalProperties: false,
    properties: { summary: { type: "string" } },
  });

  const git = async (cwd: string, args: string[]) => exec("git", ["-C", cwd, ...args]);

  beforeAll(async () => {
    repoDir = await tmp("scen05b-repo-");
    cacheRoot = await tmp("scen05b-cache-");
    storeDir = await tmp("scen05b-store-");
    await mkdir(join(repoDir, "pipelines"), { recursive: true });
    await mkdir(join(repoDir, "prompts"), { recursive: true });
    await mkdir(join(repoDir, "schemas"), { recursive: true });
    await writeFile(join(repoDir, "pipelines", "fixture.pipeline.yaml"), pipelineYaml, "utf8");
    await writeFile(join(repoDir, "prompts", "analyze.md"), "Analyze {{input}}", "utf8");
    await writeFile(join(repoDir, "schemas", "out.schema.json"), schemaJson, "utf8");
    await git(repoDir, ["init", "-q", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "Test"]);
    await git(repoDir, ["config", "commit.gpgsign", "false"]);
    await git(repoDir, ["add", "."]);
    await git(repoDir, ["commit", "-q", "-m", "initial pipeline"]);
    headSha = (await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
  });
  afterAll(async () => {
    for (const d of [repoDir, cacheRoot, storeDir]) await rm(d, { recursive: true, force: true });
  });

  it("runs a pipeline resolved from a Git repo, recording the commit SHA", async () => {
    // Real-world this is git+https://github.com/<owner>/<repo>.git#main:. — here a
    // local file:// clone keeps the scenario offline and deterministic.
    const registry = new GitPromptRegistry(`git+file://${repoDir}#main:.`, { cacheRoot });
    const store = new FilesystemResultStore(storeDir);
    const providers = new ProviderRegistry().register(new MockProvider());
    const executor = new PipelineExecutor({ registry, providers, store });
    const run = await executor.run({
      pipelineId: "fixture_pipeline",
      input: "the topic",
      options: { providers: ["mock"] },
    });
    expect(run.status).toBe("completed");
    expect(run.source.registry).toBe("git");
    expect(run.source.commitSha).toBe(headSha);
    expect(run.source.ref).toBe("main");
  });

  it("the CLI kernel picks the filesystem registry for a plain path", () => {
    expect(createKernel({ registryRoot: examplesRoot }).registry.name).toBe("filesystem");
  });

  it("the CLI kernel picks the Git registry for a git+ URI and runs it", async () => {
    // Override HOME so GitPromptRegistry's default clone cache lands in a temp
    // dir (createKernel doesn't expose cacheRoot).
    const homeOverride = await tmp("scen05b-home-");
    const storeOverride = await tmp("scen05b-clistore-");
    const prevHome = process.env.HOME;
    process.env.HOME = homeOverride;
    try {
      const kernel = createKernel({
        registryRoot: `git+file://${repoDir}#main:.`,
        storeRoot: storeOverride,
      });
      expect(kernel.registry.name).toBe("git");
      const run = await kernel.executor.run({
        pipelineId: "fixture_pipeline",
        input: "via the CLI kernel",
        options: { providers: ["mock"] },
      });
      expect(run.source.registry).toBe("git");
      expect(run.source.commitSha).toBe(headSha);
    } finally {
      if (prevHome === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = prevHome;
      for (const d of [homeOverride, storeOverride]) await rm(d, { recursive: true, force: true });
    }
  });
});
