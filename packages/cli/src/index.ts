#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  ExternalRegistryError,
  FederationError,
  InstanceKeypair,
  ModelSelector,
  PipelineValidator,
  ProviderRegistry,
  ReplayError,
  Replayer,
  ResumeError,
  type RunResult,
  type SelectionWeights,
  type TimeRange,
  costStats,
  diffRuns,
  failureStats,
  isExternalReference,
  latencyStats,
  renderCostTable,
  renderDiffMarkdown,
  renderFailureTable,
  renderLatencyTable,
  renderSelectionTable,
  statsUnsupportedError,
  verifyBundleDir,
} from "@llm-pipe/core";
import { AnthropicProvider } from "@llm-pipe/provider-anthropic";
import { MockProvider } from "@llm-pipe/provider-mock";
import {
  DelegatedAgentProvider,
  OpenAICompatibleProvider,
} from "@llm-pipe/provider-openai-compatible";
import { FilesystemPromptRegistry } from "@llm-pipe/registry-filesystem";
import { SqliteResultStore } from "@llm-pipe/store-sqlite";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { createKernel, externalExecutor } from "./kernel.js";

/** Parse YAML/JSON text into a plain object for structural validation. */
function parseAsObject(text: string): unknown {
  return parseYaml(text);
}

const program = new Command();
program
  .name("llm-pipe")
  .description("Inspectable execution kernel for recurring analytical LLM workflows")
  .option("--registry <dir>", "registry root (default: examples or $LLM_PIPE_REGISTRY)")
  .option(
    "--store <target>",
    "result store: a directory path (filesystem, default) or 'sqlite[:<path>]'",
  );

/**
 * Resolve the --store flag. A value of `sqlite` or `sqlite:<path>` selects the
 * SQLite store (defaulting to `.runs/runs.sqlite`); any other value is treated
 * as a filesystem store root (preserving prior behavior).
 */
function kernelFromOpts() {
  const opts = program.opts<{ registry?: string; store?: string }>();
  const storeOpt = opts.store;
  if (storeOpt && /^sqlite(:|$)/.test(storeOpt)) {
    const path = storeOpt.slice("sqlite".length).replace(/^:/, "") || ".runs/runs.sqlite";
    return createKernel({ registryRoot: opts.registry, store: new SqliteResultStore(path) });
  }
  return createKernel({ registryRoot: opts.registry, storeRoot: storeOpt });
}

/**
 * Materialize every stored RunResult for cross-run aggregation. Stats are
 * SQLite-only: if the active store is not the SQLite store, returns the
 * structured `stats_requires_sqlite` error instead (filesystem is too slow for
 * aggregation — one disk read per run).
 */
async function loadAllRunsForStats(
  store: ReturnType<typeof kernelFromOpts>["store"],
): Promise<{ runs: RunResult[] } | { error: ReturnType<typeof statsUnsupportedError> }> {
  if (store.name !== "sqlite") {
    return { error: statsUnsupportedError(store.name) };
  }
  const ids = await store.listRuns();
  const runs: RunResult[] = [];
  for (const id of ids) {
    const r = await store.getRun(id);
    if (r) runs.push(r);
  }
  return { runs };
}

/** Build a TimeRange from a `--range` window like `7d`, `24h`, or an ISO date. */
function parseRange(window?: string): TimeRange | undefined {
  if (!window) return undefined;
  const rel = /^(\d+)([dh])$/.exec(window.trim());
  if (rel) {
    const n = Number.parseInt(rel[1]!, 10);
    const ms = rel[2] === "d" ? n * 86_400_000 : n * 3_600_000;
    return { after: new Date(Date.now() - ms).toISOString() };
  }
  // Otherwise treat the value as an inclusive ISO lower bound.
  return { after: window.trim() };
}

program
  .command("run")
  .description("Run a pipeline against an input file")
  .argument("<pipeline>", "pipeline id")
  .argument("<input-file>", "path to input markdown/text file")
  .option("--providers <list>", "comma-separated provider ids", "mock")
  .option("--depth <n>", "recursion max depth override", (v) => Number.parseInt(v, 10))
  .option("--concurrency <n>", "max concurrent channels", (v) => Number.parseInt(v, 10))
  .option("--export [dir]", "export a run bundle after the run")
  .action(async (pipeline: string, inputFile: string, opts) => {
    const kernel = kernelFromOpts();
    const { exporter, store } = kernel;
    // An external reference (<host>/<namespace>/<id>@<version>) is resolved over
    // HTTPS against the trusted-host allowlist; a plain id uses the local registry.
    const executor = isExternalReference(pipeline)
      ? externalExecutor(kernel).executor
      : kernel.executor;
    const input = await readFile(inputFile, "utf8");
    const providers = String(opts.providers)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    let result: RunResult;
    try {
      result = await executor.run({
        pipelineId: pipeline,
        input,
        options: { providers, depth: opts.depth, maxConcurrency: opts.concurrency },
      });
    } catch (err) {
      if (err instanceof ExternalRegistryError) {
        console.error(JSON.stringify({ error: err.message, code: err.code }, null, 2));
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    if (opts.export) {
      const outDir = typeof opts.export === "string" ? opts.export : "run_bundles";
      const exported = await exporter.export(result, { outDir });
      result.artifacts.bundlePath = exported.bundlePath;
      await store.saveRun(result);
      console.error(`Bundle exported to ${exported.bundlePath}`);
    }
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("resume")
  .description("Resume a prior partial run from its last-good channel")
  .argument("<run-id>", "the prior run id to resume")
  .option("--export [dir]", "export a run bundle after the resumed run")
  .action(async (runId: string, opts) => {
    const { executor, exporter, store } = kernelFromOpts();
    let result: Awaited<ReturnType<typeof executor.resume>>;
    try {
      result = await executor.resume(runId);
    } catch (err) {
      if (err instanceof ResumeError) {
        console.error(JSON.stringify(err.toStructured(), null, 2));
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    if (opts.export) {
      const outDir = typeof opts.export === "string" ? opts.export : "run_bundles";
      const exported = await exporter.export(result, { outDir });
      result.artifacts.bundlePath = exported.bundlePath;
      await store.saveRun(result);
      console.error(`Bundle exported to ${exported.bundlePath}`);
    }
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("list-pipelines")
  .description("List available pipelines")
  .action(async () => {
    const { registry } = kernelFromOpts();
    const ids = await registry.listPipelines();
    console.log(JSON.stringify(ids, null, 2));
  });

program
  .command("get-run")
  .description("Fetch a stored run result")
  .argument("<run-id>")
  .action(async (runId: string) => {
    const { store } = kernelFromOpts();
    const run = await store.getRun(runId);
    if (!run) {
      console.error(`Run not found: ${runId}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(run, null, 2));
  });

program
  .command("export-run")
  .description("Export a stored run as a run bundle")
  .argument("<run-id>")
  .option("--out <dir>", "output directory", "run_bundles")
  .option("--redacted", "redact obvious secrets from raw outputs")
  .option("--sign", "attach a detached Ed25519 signature + canonical reference")
  .action(async (runId: string, opts) => {
    const { store, exporter } = kernelFromOpts();
    const run = await store.getRun(runId);
    if (!run) {
      console.error(`Run not found: ${runId}`);
      process.exitCode = 1;
      return;
    }
    const keypair = opts.sign ? new InstanceKeypair().ensure() : undefined;
    const exported = await exporter.export(run, {
      outDir: opts.out,
      redacted: opts.redacted,
      keypair,
    });
    console.log(JSON.stringify(exported, null, 2));
  });

program
  .command("validate-pipeline")
  .description("Structurally validate a pipeline definition file")
  .argument("<path>", "path to a .pipeline.yaml file")
  .action(async (pipelinePath: string) => {
    const opts = program.opts<{ registry?: string }>();
    // The registry root is the parent of the file's directory when the file
    // lives in a `pipelines/` folder (matching the registry layout), else the
    // file's own directory. An explicit --registry always wins.
    const fileDir = dirname(resolve(pipelinePath));
    const registryRoot =
      opts.registry ?? (basename(fileDir) === "pipelines" ? dirname(fileDir) : fileDir);
    const registry = new FilesystemPromptRegistry(registryRoot);
    const providers = new ProviderRegistry()
      .register(new MockProvider())
      .register(new OpenAICompatibleProvider())
      .register(new DelegatedAgentProvider())
      .register(new AnthropicProvider());

    let rawSpec: unknown;
    try {
      rawSpec = parseAsObject(await readFile(pipelinePath, "utf8"));
    } catch (err) {
      const report = {
        valid: false,
        pipelineId: null,
        issues: [{ check: "spec_schema", message: `Cannot read/parse pipeline: ${String(err)}` }],
      };
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = 1;
      return;
    }

    const validator = new PipelineValidator({
      loadPrompt: (p) => registry.loadPrompt(p),
      loadSchema: (p) => registry.loadSchema(p),
      hasProvider: (t) => providers.has(t),
    });
    const report = await validator.validate(rawSpec);
    console.log(JSON.stringify(report, null, 2));
    if (!report.valid) process.exitCode = 1;
  });

const stats = program
  .command("stats")
  .description("Cross-run aggregate queries (SQLite store only)");

stats
  .command("cost")
  .description("Cost over time, bucketed by day")
  .option("--pipeline <id>", "filter to a single pipeline")
  .option("--range <window>", "time window, e.g. 7d, 24h, or an ISO lower bound")
  .option("--json", "emit raw JSON instead of an ASCII table")
  .action(async (opts) => {
    const { store } = kernelFromOpts();
    const loaded = await loadAllRunsForStats(store);
    if ("error" in loaded) {
      console.error(JSON.stringify(loaded.error, null, 2));
      process.exitCode = 1;
      return;
    }
    const result = costStats(loaded.runs, {
      pipelineId: opts.pipeline,
      range: parseRange(opts.range),
    });
    console.log(opts.json ? JSON.stringify(result, null, 2) : renderCostTable(result));
  });

stats
  .command("latency")
  .description("Latency by provider")
  .option("--provider <id>", "filter to a single provider")
  .option("--range <window>", "time window, e.g. 7d, 24h, or an ISO lower bound")
  .option("--json", "emit raw JSON instead of an ASCII table")
  .action(async (opts) => {
    const { store } = kernelFromOpts();
    const loaded = await loadAllRunsForStats(store);
    if ("error" in loaded) {
      console.error(JSON.stringify(loaded.error, null, 2));
      process.exitCode = 1;
      return;
    }
    const result = latencyStats(loaded.runs, {
      provider: opts.provider,
      range: parseRange(opts.range),
    });
    console.log(opts.json ? JSON.stringify(result, null, 2) : renderLatencyTable(result));
  });

stats
  .command("failures")
  .description("Validation failure rate by pipeline and top failed channels")
  .option("--range <window>", "time window, e.g. 7d, 24h, or an ISO lower bound")
  .option("--top <n>", "number of top failed channels", (v) => Number.parseInt(v, 10))
  .option("--json", "emit raw JSON instead of an ASCII table")
  .action(async (opts) => {
    const { store } = kernelFromOpts();
    const loaded = await loadAllRunsForStats(store);
    if ("error" in loaded) {
      console.error(JSON.stringify(loaded.error, null, 2));
      process.exitCode = 1;
      return;
    }
    const result = failureStats(loaded.runs, { range: parseRange(opts.range), topN: opts.top });
    console.log(opts.json ? JSON.stringify(result, null, 2) : renderFailureTable(result));
  });

program
  .command("diff")
  .description("Diff two stored runs of the same pipeline")
  .argument("<run-id-a>")
  .argument("<run-id-b>")
  .option("--format <format>", "output format: markdown (default) or json", "markdown")
  .action(async (idA: string, idB: string, opts) => {
    const { store } = kernelFromOpts();
    const runA = await store.getRun(idA);
    const runB = await store.getRun(idB);
    if (!runA) {
      console.error(`Run not found: ${idA}`);
      process.exitCode = 1;
      return;
    }
    if (!runB) {
      console.error(`Run not found: ${idB}`);
      process.exitCode = 1;
      return;
    }
    try {
      const diff = diffRuns(runA, runB);
      if (opts.format === "json") {
        console.log(JSON.stringify(diff, null, 2));
      } else {
        console.log(renderDiffMarkdown(diff));
      }
    } catch (err) {
      // Refuse-to-diff (different pipelineHash) is a structured, expected error.
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "pipeline_mismatch"
      ) {
        console.error((err as { message?: string }).message ?? String(err));
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

program
  .command("select-model")
  .description("Rank providers for a pipeline by validation, cost, latency, and conformance")
  .requiredOption("--pipeline <id>", "pipeline id")
  .requiredOption("--input <file>", "path to an input file")
  .requiredOption("--providers <list>", "comma-separated provider ids to compare")
  .option("--runs <n>", "runs per provider", (v) => Number.parseInt(v, 10), 3)
  .option("--weight-validation <n>", "validation weight", (v) => Number.parseFloat(v))
  .option("--weight-conformance <n>", "structural-conformance weight", (v) => Number.parseFloat(v))
  .option("--weight-cost <n>", "cost weight", (v) => Number.parseFloat(v))
  .option("--weight-latency <n>", "latency weight", (v) => Number.parseFloat(v))
  .option("--json", "emit raw JSON instead of an ASCII table")
  .action(async (opts) => {
    const { executor } = kernelFromOpts();
    const input = await readFile(opts.input, "utf8");
    const providers = String(opts.providers)
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    const weights: Partial<SelectionWeights> = {};
    if (opts.weightValidation !== undefined) weights.validation = opts.weightValidation;
    if (opts.weightConformance !== undefined) weights.conformance = opts.weightConformance;
    if (opts.weightCost !== undefined) weights.cost = opts.weightCost;
    if (opts.weightLatency !== undefined) weights.latency = opts.weightLatency;
    const selector = new ModelSelector({ executor });
    const report = await selector.select({
      pipelineId: opts.pipeline,
      input,
      providers,
      runs: opts.runs,
      weights,
    });
    console.log(opts.json ? JSON.stringify(report, null, 2) : renderSelectionTable(report));
  });

program
  .command("replay")
  .description("Replay a run from its exported bundle directory (verifies hashes first)")
  .argument("<bundle-path>", "path to a run bundle directory")
  .option("--providers <list>", "comma-separated provider ids for the replay")
  .option("--format <format>", "diff output format: markdown (default) or json", "markdown")
  .action(async (bundlePath: string, opts) => {
    const { registry, executor, store } = kernelFromOpts();
    const replayer = new Replayer({ registry, executor, store });
    const providers = opts.providers
      ? String(opts.providers)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined;
    try {
      const { originalRunId, replay, diff } = await replayer.replay(bundlePath, { providers });
      console.error(`Replayed ${originalRunId} -> ${replay.runId}`);
      if (opts.format === "json") {
        console.log(JSON.stringify({ replay, diff }, null, 2));
      } else {
        console.log(renderDiffMarkdown(diff));
      }
    } catch (err) {
      if (err instanceof ReplayError) {
        console.error(JSON.stringify(err.toStructured(), null, 2));
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

program
  .command("verify-bundle")
  .description("Verify a run bundle's detached Ed25519 signature and content hash")
  .argument("<bundle-path>", "path to a signed run bundle directory")
  .option("--public-key <pem-file>", "verify against a specific (allowlisted) public key PEM file")
  .action(async (bundlePath: string, opts) => {
    let expectedKey: string | undefined;
    if (opts.publicKey) {
      expectedKey = await readFile(opts.publicKey, "utf8");
    }
    const verdict = await verifyBundleDir(bundlePath, expectedKey);
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.valid) process.exitCode = 1;
  });

program
  .command("export-key")
  .description("Print this instance's Ed25519 public key (generates a keypair on first use)")
  .action(async () => {
    const keypair = new InstanceKeypair().ensure();
    process.stdout.write(keypair.publicKeyPem());
  });

program
  .command("fetch-run")
  .description("Fetch a signed run from a trusted remote instance and store it read-only")
  .argument("<canonical-ref>", "calane://run/<hash> reference")
  .requiredOption("--instance <id-or-url>", "allowlisted remote instance id or base URL")
  .action(async (canonicalRef: string, opts) => {
    const { federation } = kernelFromOpts();
    try {
      const result = await federation.fetchRun(canonicalRef, opts.instance);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      if (err instanceof FederationError) {
        console.error(JSON.stringify({ error: err.message, code: err.code }, null, 2));
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
