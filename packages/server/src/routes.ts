import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CallbackPayload,
  FederationError,
  PipelineValidator,
  ResumeError,
  type RunResult,
  type TimeRange,
  costStats,
  diffRuns,
  failureStats,
  isRunRef,
  latencyStats,
  nonceKey,
  readBundleFiles,
  statsUnsupportedError,
  verifyCallback,
} from "@llm-pipe/core";
import type { FastifyInstance } from "fastify";
import type { Kernel } from "./kernel.js";

/** Configurable replay window for delegated-agent callbacks (default 1 hour). */
function callbackWindowMs(): number {
  const raw = process.env.LLM_PIPE_CALLBACK_WINDOW_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
}

/**
 * Registers the compact REST surface. These endpoints back the same 8 coarse
 * tools exposed via MCP and openai.json — no per-internal-function routes.
 */
/** Parse a `range` query value (`7d`, `24h`, or an ISO lower bound) into a TimeRange. */
function parseRange(window?: string): TimeRange | undefined {
  if (!window) return undefined;
  const rel = /^(\d+)([dh])$/.exec(window.trim());
  if (rel) {
    const n = Number.parseInt(rel[1] as string, 10);
    const ms = rel[2] === "d" ? n * 86_400_000 : n * 3_600_000;
    return { after: new Date(Date.now() - ms).toISOString() };
  }
  return { after: window.trim() };
}

export function registerRoutes(app: FastifyInstance, kernel: Kernel): void {
  /**
   * Load every stored RunResult for cross-run aggregation. Stats are SQLite-only:
   * a non-SQLite store yields the structured `stats_requires_sqlite` error.
   */
  const loadAllRunsForStats = async (): Promise<
    { runs: RunResult[] } | { error: ReturnType<typeof statsUnsupportedError> }
  > => {
    if (kernel.store.name !== "sqlite") {
      return { error: statsUnsupportedError(kernel.store.name) };
    }
    const ids = await kernel.store.listRuns();
    const runs: RunResult[] = [];
    for (const id of ids) {
      const r = await kernel.store.getRun(id);
      if (r) runs.push(r);
    }
    return { runs };
  };

  // POST /runs -> run_pipeline
  app.post("/runs", async (req, reply) => {
    const body = req.body as {
      pipelineId?: string;
      input?: string;
      options?: Record<string, unknown>;
    };
    if (!body?.pipelineId || typeof body.input !== "string") {
      return reply.code(400).send({ error: "pipelineId and input are required" });
    }
    const result = await kernel.executor.run({
      pipelineId: body.pipelineId,
      input: body.input,
      options: body.options as any,
    });
    return reply.code(201).send(result);
  });

  // POST /runs/:runId/resume -> resume a prior partial run.
  // Folds into the run_pipeline tool surface (no new MCP/openai tool); the
  // MCP/openai equivalent is run_pipeline with options.resumeFromRunId.
  app.post("/runs/:runId/resume", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    try {
      const result = await kernel.executor.resume(runId);
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof ResumeError) {
        const code = err.code === "run_not_found" ? 404 : 409;
        return reply.code(code).send(err.toStructured());
      }
      throw err;
    }
  });

  // GET /runs -> list_runs
  app.get("/runs", async () => ({ runs: await kernel.store.listRuns() }));

  // GET /runs/:runId -> get_run_result
  app.get("/runs/:runId", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = await kernel.store.getRun(runId);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });

  // GET /runs/:idA/diff/:idB -> structural + content diff of two runs.
  // Folds into the existing run-inspection surface (no new MCP/openai tool).
  // Refuses (409) when the two runs are of different pipeline definitions.
  app.get("/runs/:idA/diff/:idB", async (req, reply) => {
    const { idA, idB } = req.params as { idA: string; idB: string };
    const runA = await kernel.store.getRun(idA);
    if (!runA) return reply.code(404).send({ error: `run not found: ${idA}` });
    const runB = await kernel.store.getRun(idB);
    if (!runB) return reply.code(404).send({ error: `run not found: ${idB}` });
    try {
      return diffRuns(runA, runB);
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) {
        const e = err as { code: string; toStructured?: () => unknown };
        if (e.code === "pipeline_mismatch") {
          return reply.code(409).send(e.toStructured ? e.toStructured() : { error: String(err) });
        }
      }
      throw err;
    }
  });

  // Cross-run aggregate queries (SQLite store only). These fold into the
  // existing read surface — no new MCP/openai tool. A non-SQLite store yields a
  // 409 with the structured `stats_requires_sqlite` error.
  // GET /stats/cost?pipeline=&range=
  app.get("/stats/cost", async (req, reply) => {
    const q = req.query as { pipeline?: string; range?: string };
    const loaded = await loadAllRunsForStats();
    if ("error" in loaded) return reply.code(409).send(loaded.error);
    return costStats(loaded.runs, { pipelineId: q.pipeline, range: parseRange(q.range) });
  });

  // GET /stats/latency?provider=&range=
  app.get("/stats/latency", async (req, reply) => {
    const q = req.query as { provider?: string; range?: string };
    const loaded = await loadAllRunsForStats();
    if ("error" in loaded) return reply.code(409).send(loaded.error);
    return latencyStats(loaded.runs, { provider: q.provider, range: parseRange(q.range) });
  });

  // GET /stats/failures?range=&top=
  app.get("/stats/failures", async (req, reply) => {
    const q = req.query as { range?: string; top?: string };
    const loaded = await loadAllRunsForStats();
    if ("error" in loaded) return reply.code(409).send(loaded.error);
    const topN = q.top ? Number.parseInt(q.top, 10) : undefined;
    return failureStats(loaded.runs, { range: parseRange(q.range), topN });
  });

  // GET /pipelines -> list_pipelines
  app.get("/pipelines", async () => ({ pipelines: await kernel.registry.listPipelines() }));

  // SERVE half of the external registry protocol (S24): resolve a pipeline spec
  // by namespace/id for another instance to fetch read-only. NOT a marketplace —
  // resolution only; no publication/curation/ratings. The namespace is a logical
  // grouping; the local pipeline id must match `:id`.
  app.get("/pipelines/:namespace/:id", async (req, reply) => {
    const { id } = req.params as { namespace: string; id: string };
    try {
      const resolved = await kernel.registry.resolvePipeline(id);
      // Return the raw spec so a resolving instance can hash + cache it verbatim.
      reply.header("content-type", "application/json");
      return reply.code(200).send(JSON.stringify(resolved.spec));
    } catch (err) {
      return reply.code(404).send({ error: `pipeline not found: ${id} (${String(err)})` });
    }
  });

  // GET /pipelines/:pipelineId -> get_pipeline_spec
  app.get("/pipelines/:pipelineId", async (req, reply) => {
    const { pipelineId } = req.params as { pipelineId: string };
    try {
      const resolved = await kernel.registry.resolvePipeline(pipelineId);
      return resolved;
    } catch (err) {
      return reply.code(404).send({ error: String(err) });
    }
  });

  // POST /pipelines/:pipelineId/validate -> validate_pipeline
  app.post("/pipelines/:pipelineId/validate", async (req, reply) => {
    const { pipelineId } = req.params as { pipelineId: string };
    let resolved: Awaited<ReturnType<typeof kernel.registry.resolvePipeline>>;
    try {
      resolved = await kernel.registry.resolvePipeline(pipelineId);
    } catch (err) {
      return reply.code(404).send({
        valid: false,
        pipelineId,
        issues: [{ check: "spec_schema", message: `Pipeline not found: ${String(err)}` }],
      });
    }
    const validator = new PipelineValidator({
      loadPrompt: (p) => kernel.registry.loadPrompt(p),
      loadSchema: (p) => kernel.registry.loadSchema(p),
      hasProvider: (t) => kernel.providers.has(t),
    });
    const report = await validator.validate(resolved.spec);
    return reply.code(200).send({ ...report, pipelineHash: resolved.pipelineHash });
  });

  // POST /runs/:runId/rerun-channel -> rerun_channel
  app.post("/runs/:runId/rerun-channel", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const { channelId } = (req.body as { channelId?: string }) ?? {};
    const prior = await kernel.store.getRun(runId);
    if (!prior) return reply.code(404).send({ error: "run not found" });
    if (!channelId) return reply.code(400).send({ error: "channelId is required" });
    // Re-run the whole pipeline from the prior input; return the fresh channel.
    const fresh = await kernel.executor.run({ pipelineId: prior.pipelineId, input: prior.input });
    const channel =
      fresh.channels.find((c) => c.channelId === channelId) ??
      (fresh.synthesis?.channelId === channelId ? fresh.synthesis : null);
    if (!channel) return reply.code(404).send({ error: `channel not found: ${channelId}` });
    return { runId: fresh.runId, channel };
  });

  // GET /runs/:runId/export -> export_run_bundle
  app.get("/runs/:runId/export", async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const q = req.query as { redacted?: string; outDir?: string };
    const run = await kernel.store.getRun(runId);
    if (!run) return reply.code(404).send({ error: "run not found" });
    const outDir = q.outDir ?? join(tmpdir(), "llm-pipe-bundles");
    const exported = await kernel.exporter.export(run, {
      outDir,
      redacted: q.redacted === "true",
    });
    return exported;
  });

  // POST /runs/:runId/channels/:channelId/callback -> delegated-agent callback.
  // Verifies the HMAC-SHA256 signature against the per-channel secret minted at
  // dispatch. Rejects unsigned / invalid / expired / replayed callbacks with 401.
  app.post("/runs/:runId/channels/:channelId/callback", async (req, reply) => {
    const { runId, channelId } = req.params as { runId: string; channelId: string };
    const body = (req.body ?? {}) as Partial<CallbackPayload> & { signature?: string };
    const signature = (req.headers["x-callback-signature"] as string | undefined) ?? body.signature;

    const secret = await kernel.secretStore.get(runId, channelId);
    if (!secret) {
      return reply.code(401).send({ error: "no signing secret for this run/channel" });
    }
    if (
      typeof body.nonce !== "string" ||
      typeof body.timestamp !== "string" ||
      body.result === undefined
    ) {
      return reply.code(400).send({ error: "callback requires nonce, timestamp, and result" });
    }

    const payload: CallbackPayload = {
      runId,
      channelId,
      nonce: body.nonce,
      timestamp: body.timestamp,
      result: body.result,
    };

    const verdict = verifyCallback({
      secret,
      payload,
      signature,
      windowMs: callbackWindowMs(),
      isNonceSeen: () => false, // replay check is done atomically below
    });
    if (!verdict.valid) {
      return reply.code(401).send({ error: `callback rejected: ${verdict.reason}` });
    }
    // Atomically consume the nonce to block replays.
    const replayed = await kernel.secretStore.markNonceSeen(nonceKey(payload));
    if (replayed) {
      return reply.code(401).send({ error: "callback rejected: replayed" });
    }
    return reply.code(200).send({ accepted: true, runId, channelId });
  });

  // --- Federation (S22) -----------------------------------------------------

  /**
   * Export + sign a local run as a bundle, returning its file map and canonical
   * reference. The signing private key never leaves the instance; only the
   * public key + signature go into the served file map.
   */
  const exportSignedFiles = async (
    run: RunResult,
  ): Promise<{ files: Record<string, string>; canonicalRef: string }> => {
    const outDir = await mkdtemp(join(tmpdir(), "calane-fed-"));
    try {
      const exported = await kernel.exporter.export(run, { outDir, keypair: kernel.keypair });
      const files = await readBundleFiles(exported.bundlePath);
      return { files, canonicalRef: exported.canonicalRef as string };
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  };

  // SERVE half: GET /federated/bundles/:ref -> a signed bundle for a local run
  // matching the requested canonical reference. Lets another instance fetch a
  // run from this one (read-only).
  app.get("/federated/bundles/:ref", async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const canonicalRef = decodeURIComponent(ref);
    if (!isRunRef(canonicalRef)) {
      return reply.code(400).send({ error: `not a canonical run reference: ${canonicalRef}` });
    }
    const ids = await kernel.store.listRuns();
    for (const id of ids) {
      const run = await kernel.store.getRun(id);
      if (!run) continue;
      const signed = await exportSignedFiles(run);
      if (signed.canonicalRef === canonicalRef) {
        return reply.code(200).send({ files: signed.files });
      }
    }
    return reply.code(404).send({ error: `no local run matches ${canonicalRef}` });
  });

  // FETCH half: GET /federated/runs/:ref?instance=<id> -> fetch from a trusted
  // remote, verify its signature against the allowlisted key, store foreign.
  app.get("/federated/runs/:ref", async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const { instance } = req.query as { instance?: string };
    const canonicalRef = decodeURIComponent(ref);
    if (!isRunRef(canonicalRef)) {
      return reply.code(400).send({ error: `not a canonical run reference: ${canonicalRef}` });
    }
    if (!instance) {
      return reply.code(400).send({ error: "instance (allowlisted id or base URL) is required" });
    }
    try {
      const result = await kernel.federation.fetchRun(canonicalRef, instance);
      return reply.code(result.alreadyPresent ? 200 : 201).send(result);
    } catch (err) {
      if (err instanceof FederationError) {
        const code = err.code === "untrusted_instance" ? 403 : 502;
        return reply.code(code).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  // GET /federated/runs -> list locally-stored foreign run hashes + provenance.
  app.get("/federated/runs", async () => {
    const hashes = await kernel.foreignStore.list();
    const runs = await Promise.all(
      hashes.map(async (h) => kernel.foreignStore.getProvenance(`calane://run/${h}`)),
    );
    return { runs: runs.filter((p) => p !== null) };
  });
}
