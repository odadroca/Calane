import pLimit from "p-limit";
import type {
  EnforcementPolicyInterface,
  PolicyDecisionRecord,
  PolicyPluginInterface,
} from "../plugins/PolicyPlugin.js";
import type { PromptRegistryInterface } from "../plugins/PromptRegistry.js";
import type { ProviderRegistry } from "../plugins/ProviderAdapter.js";
import type { ResultStoreInterface } from "../plugins/ResultStore.js";
import type { TelemetrySinkInterface } from "../plugins/TelemetrySink.js";
import { NoopTelemetrySink } from "../plugins/TelemetrySink.js";
import { PromptRenderer } from "../rendering/PromptRenderer.js";
import type { ChannelSpec } from "../specs/ChannelSpec.js";
import type { PipelineDefaults } from "../specs/PipelineSpec.js";
import type { RunRequest } from "../specs/RunRequest.js";
import type { ChannelResult, PolicyDecision, RunResult } from "../specs/RunResult.js";
import { canonicalJson, generateRunId, sha256 } from "../util/hash.js";
import { JsonSchemaValidator } from "../validation/JsonSchemaValidator.js";
import { executeChannel } from "./ChannelExecutor.js";
import { type PlannedChannel, buildExecutionPlan } from "./ExecutionPlan.js";
import { DefaultRecursionPolicy } from "./RecursionPolicy.js";

export interface PipelineExecutorDeps {
  registry: PromptRegistryInterface;
  providers: ProviderRegistry;
  store: ResultStoreInterface;
  telemetry?: TelemetrySinkInterface;
  policy?: PolicyPluginInterface;
  /** Enforcement policies invoked at the before/after-channel hook points. */
  policies?: EnforcementPolicyInterface[];
  renderer?: PromptRenderer;
  validator?: JsonSchemaValidator;
}

export class PipelineExecutor {
  private readonly registry: PromptRegistryInterface;
  private readonly providers: ProviderRegistry;
  private readonly store: ResultStoreInterface;
  private readonly telemetry: TelemetrySinkInterface;
  private readonly policy: PolicyPluginInterface;
  private readonly policies: EnforcementPolicyInterface[];
  private readonly renderer: PromptRenderer;
  private readonly validator: JsonSchemaValidator;

  constructor(deps: PipelineExecutorDeps) {
    this.registry = deps.registry;
    this.providers = deps.providers;
    this.store = deps.store;
    this.telemetry = deps.telemetry ?? new NoopTelemetrySink();
    this.policy = deps.policy ?? new DefaultRecursionPolicy();
    this.policies = deps.policies ?? [];
    this.renderer = deps.renderer ?? new PromptRenderer();
    this.validator = deps.validator ?? new JsonSchemaValidator();
  }

  async run(
    request: RunRequest,
    signal?: AbortSignal,
    carryForward?: { resumedFrom: string; channels: ChannelResult[] },
  ): Promise<RunResult> {
    // Resume delegation: when `resumeFromRunId` is set and this is not already a
    // carry-forward invocation, route through resume() (which re-invokes run()
    // with the carried channels and no `resumeFromRunId`, so this is not
    // recursive).
    if (request.options?.resumeFromRunId && !carryForward) {
      return this.resume(request.options.resumeFromRunId, signal);
    }

    const runId = generateRunId();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    const resolved = await this.registry.resolvePipeline(request.pipelineId);
    const spec = resolved.spec;
    const plan = buildExecutionPlan(spec, {
      providers: request.options?.providers,
      depth: request.options?.depth,
    });

    // Pre-load prompt + schema text for hashing and execution.
    const promptHashes: Record<string, string> = {};
    const schemaHashes: Record<string, string> = {};

    const traceId =
      (await this.safeTelemetry(() => this.telemetry.startTrace(runId), null)) ?? null;

    await this.safeTelemetry(() =>
      this.telemetry.emit({
        runId,
        type: "run.start",
        attributes: { "pipeline.id": spec.id, "pipeline.hash": resolved.pipelineHash },
        timestamp: new Date().toISOString(),
      }),
    );

    const result: RunResult = {
      runId,
      pipelineId: spec.id,
      status: "completed",
      startedAt,
      completedAt: null,
      input: request.input,
      source: {
        registry: resolved.registry,
        ref: resolved.ref,
        commitSha: resolved.commitSha,
        pipelineHash: resolved.pipelineHash,
        promptHashes,
        schemaHashes,
      },
      providers: plan.providers,
      recursion: {
        enabled: plan.recursionEnabled,
        maxDepth: plan.maxDepth,
        currentDepth: 0,
        carryForwardStrategy: plan.carryForwardStrategy,
      },
      channels: [],
      synthesis: null,
      resumedFrom: carryForward?.resumedFrom ?? null,
      policy: [],
      validation: { valid: true, errors: [] },
      telemetry: { traceId },
      artifacts: { bundlePath: null },
    };

    // Carry forward completed channels from a resumed run: their ids are skipped
    // during execution and their prior results are spliced into the output.
    const carriedChannels = new Map<string, ChannelResult>(
      (carryForward?.channels ?? []).map((c) => [c.channelId, c]),
    );

    // Structured concurrency: a global limiter plus per-provider limiters. The
    // pipeline `concurrency` policy takes precedence; the blanket
    // `maxConcurrency` run option remains the fallback global cap.
    const concurrency = spec.concurrency;
    const globalCap = concurrency?.global ?? request.options?.maxConcurrency ?? 4;
    const limit = pLimit(globalCap);
    const perProviderLimiters = new Map<string, ReturnType<typeof pLimit>>();
    const providerLimit = (providerId: string): ReturnType<typeof pLimit> | null => {
      const cap = concurrency?.perProvider?.[providerId];
      if (cap === undefined) return null;
      let l = perProviderLimiters.get(providerId);
      if (!l) {
        l = pLimit(cap);
        perProviderLimiters.set(providerId, l);
      }
      return l;
    };
    /** Run `fn` under the global limiter and, if configured, the provider limiter. */
    const runLimited = <T>(providerId: string, fn: () => Promise<T>): Promise<T> => {
      const pl = providerLimit(providerId);
      return limit(() => (pl ? pl(fn) : fn()));
    };

    // Internal controller so an enforcement policy's `abort`/`halt` decision can
    // cancel active provider calls. Linked to the external signal where present.
    const runController = new AbortController();
    if (signal) {
      if (signal.aborted) runController.abort();
      else signal.addEventListener("abort", () => runController.abort(), { once: true });
    }
    let halted = false;

    let depth = 0;
    let lastSynthesis: ChannelResult | null = null;

    while (true) {
      depth += 1;
      result.recursion.currentDepth = depth;

      await this.safeTelemetry(() =>
        this.telemetry.emit({
          runId,
          type: "depth.start",
          attributes: { depth },
          timestamp: new Date().toISOString(),
        }),
      );

      // Gate every channel through the enforcement-policy hooks. A
      // `beforeChannel` abort or `afterChannel` halt stops the run: no further
      // channels start and active provider calls are aborted via the signal.
      //
      // When enforcement policies are registered, channels in a depth run
      // SEQUENTIALLY so cumulative-cost policies observe prior channel cost
      // before the next channel starts (a halt then prevents the rest). With no
      // policies the prior concurrent behavior is preserved.
      const channelResults: (ChannelResult | null)[] = [];
      const onHalt = () => {
        halted = true;
      };
      // Accumulates completed channel results at THIS depth, keyed by id, so a
      // downstream channel's `dependsOn` upstream outputs can be exposed to its
      // prompt via `{{channel_results.<id>.parsed|raw}}`.
      const completedThisDepth = new Map<string, ChannelResult>();
      const buildUpstream = async (
        planned: PlannedChannel,
      ): Promise<Record<string, { parsed: string; raw: string }> | undefined> => {
        const deps = planned.channel.dependsOn ?? [];
        if (deps.length === 0) return undefined;
        const upstream: Record<string, { parsed: string; raw: string }> = {};
        for (const depId of deps) {
          const dep = completedThisDepth.get(depId);
          if (!dep) continue;
          let raw = "";
          if (dep.rawOutputRef) {
            raw = (await this.store.getRawOutput(runId, dep.rawOutputRef)) ?? "";
          }
          upstream[depId] = {
            parsed: dep.parsedOutput != null ? JSON.stringify(dep.parsedOutput, null, 2) : "",
            raw,
          };
        }
        return upstream;
      };
      const mkCtx = (upstream?: Record<string, { parsed: string; raw: string }>) => ({
        runId,
        input: request.input,
        channelResults: result.channels,
        previousSynthesis: lastSynthesis,
        recursionDepth: depth,
        resolved,
        promptHashes,
        schemaHashes,
        timeoutMs: request.options?.timeoutMs,
        signal: runController.signal,
        upstream,
      });

      // On a resume, only depth 1 carries forward completed channels. Carried
      // channels are spliced in unchanged (with their original hashes recorded);
      // the rest are executed normally.
      const carryAtThisDepth = depth === 1 ? carriedChannels : new Map<string, ChannelResult>();
      for (const planned of plan.channels) {
        const carried = carryAtThisDepth.get(planned.channel.id);
        if (!carried) continue;
        // Recompute the carried channel's prompt/schema hashes so the resumed
        // run's source hashes are complete (matches the original by construction).
        await this.recordHashes(planned, promptHashes, schemaHashes);
        result.channels.push(carried);
        channelResults.push(carried);
        completedThisDepth.set(carried.channelId, carried);
        await this.emitChannelSpan(runId, spec.id, resolved.pipelineHash, carried, false);
      }

      // Execute channels level by level (topological order). For a flat pipeline
      // `plan.levels` is a single level containing all channels in declared
      // order, so the prior behavior is preserved exactly. Channels within a
      // level are mutually independent and run concurrently (no policies) or
      // sequentially (policies registered, so cumulative-cost policies observe
      // prior cost). A halt stops launching further channels/levels.
      const recordCompleted = (c: ChannelResult | null) => {
        channelResults.push(c);
        if (c) {
          result.channels.push(c);
          completedThisDepth.set(c.channelId, c);
        }
      };
      for (const level of plan.levels) {
        if (halted) break;
        const toRun = level.filter((p) => !carryAtThisDepth.has(p.channel.id));
        if (toRun.length === 0) continue;

        if (this.policies.length > 0) {
          for (const planned of toRun) {
            const upstream = await buildUpstream(planned);
            const c = await this.runGated(
              planned,
              false,
              depth,
              result,
              runController,
              onHalt,
              mkCtx(upstream),
            );
            recordCompleted(c);
            if (c) await this.emitChannelSpan(runId, spec.id, resolved.pipelineHash, c, false);
            if (halted) break;
          }
        } else {
          // Resolve upstream context for each channel BEFORE launching the level
          // (upstream channels are in prior levels and already completed).
          const prepared = await Promise.all(
            toRun.map(async (planned) => ({ planned, upstream: await buildUpstream(planned) })),
          );
          const concurrent = await Promise.all(
            prepared.map(({ planned, upstream }) =>
              runLimited(planned.provider.id, () =>
                this.runGated(
                  planned,
                  false,
                  depth,
                  result,
                  runController,
                  onHalt,
                  mkCtx(upstream),
                ),
              ),
            ),
          );
          for (const c of concurrent) {
            recordCompleted(c);
            if (c) await this.emitChannelSpan(runId, spec.id, resolved.pipelineHash, c, false);
          }
        }
      }

      // Synthesis channel consumes the just-produced channel results.
      let synthesisResult: ChannelResult | null = null;
      if (plan.synthesis && !halted) {
        synthesisResult = await this.runGated(
          plan.synthesis,
          true,
          depth,
          result,
          runController,
          () => {
            halted = true;
          },
          {
            runId,
            input: request.input,
            channelResults: channelResults.filter((c): c is ChannelResult => c !== null),
            previousSynthesis: lastSynthesis,
            recursionDepth: depth,
            resolved,
            promptHashes,
            schemaHashes,
            timeoutMs: request.options?.timeoutMs,
            signal: runController.signal,
          },
        );
        if (synthesisResult) {
          result.synthesis = synthesisResult;
          lastSynthesis = synthesisResult;
          await this.emitChannelSpan(runId, spec.id, resolved.pipelineHash, synthesisResult, true);
        }
      }

      if (halted) break;

      const decision = this.policy.decideRecursion({
        result,
        currentDepth: depth,
        maxDepth: plan.maxDepth,
        elapsedMs: Date.now() - startMs,
        totalCostUsd: totalCost(result),
        maxRuntimeMs: spec.recursion?.maxRuntimeMs,
        maxCostUsd: spec.recursion?.maxCostUsd,
      });

      if (!plan.recursionEnabled || !decision.shouldRecurse) break;
    }

    // Aggregate validation status.
    const failed: ChannelResult[] = [...result.channels];
    if (result.synthesis) failed.push(result.synthesis);
    const invalid = failed.filter((c) => !c.schemaValid && c.status !== "ok");
    result.validation.valid = invalid.length === 0;
    result.validation.errors = invalid.map((c) => ({
      channelId: c.channelId,
      status: c.status,
    }));

    const anyError = failed.some((c) => c.status === "error" || c.status === "timeout");
    const allError = failed.length > 0 && failed.every((c) => c.status !== "ok");
    result.status = allError
      ? "failed"
      : anyError || !result.validation.valid
        ? "partial"
        : "completed";

    result.completedAt = new Date().toISOString();

    await this.safeTelemetry(() =>
      this.telemetry.emit({
        runId,
        type: "run.end",
        attributes: { status: result.status, "validation.valid": result.validation.valid },
        timestamp: new Date().toISOString(),
      }),
    );
    await this.safeTelemetry(() => this.telemetry.endTrace(runId));
    await this.store.saveRun(result);
    return result;
  }

  /**
   * Emit a `channel.end` telemetry event carrying the attributes a span-building
   * sink needs (per the S3 contract). Observational only — wrapped so a sink
   * failure never fails the run.
   */
  private async emitChannelSpan(
    runId: string,
    pipelineId: string,
    pipelineHash: string,
    c: ChannelResult,
    isSynthesis: boolean,
  ): Promise<void> {
    await this.safeTelemetry(() =>
      this.telemetry.emit({
        runId,
        channelId: c.channelId,
        type: "channel.end",
        attributes: {
          "pipeline.id": pipelineId,
          "pipeline.hash": pipelineHash,
          "channel.id": c.channelId,
          "provider.id": (c.metadata?.providerId as string | undefined) ?? c.provider,
          model: c.model,
          "usage.input_tokens": c.usage.inputTokens,
          "usage.output_tokens": c.usage.outputTokens,
          "usage.cost_usd": c.usage.costUsd,
          latency_ms: c.latencyMs,
          "validation.status": c.status,
          "channel.is_synthesis": isSynthesis,
        },
        timestamp: new Date().toISOString(),
      }),
    );
  }

  /**
   * Run a channel through the enforcement-policy hooks. Returns the channel
   * result, or `null` when a policy `beforeChannel` decision is `skip`/`abort`
   * (the channel never ran). All policy decisions are recorded on
   * `result.policy` and surfaced as a `policy.decision` telemetry attribute.
   * On `abort` (before) or `halt` (after), the run controller is aborted and
   * `onHalt()` is invoked so the executor stops launching further channels.
   */
  private async runGated(
    planned: PlannedChannel,
    isSynthesis: boolean,
    depth: number,
    result: RunResult,
    controller: AbortController,
    onHalt: () => void,
    ctx: {
      runId: string;
      input: string;
      channelResults: ChannelResult[];
      previousSynthesis: ChannelResult | null;
      recursionDepth: number;
      resolved: { spec: { id: string } };
      promptHashes: Record<string, string>;
      schemaHashes: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
      upstream?: Record<string, { parsed: string; raw: string }>;
    },
  ): Promise<ChannelResult | null> {
    const channelId = planned.channel.id;

    // If the run was already halted/aborted by a prior channel, skip silently.
    if (controller.signal.aborted) return null;

    // beforeChannel hooks (registration order).
    for (const policy of this.policies) {
      if (!policy.beforeChannel) continue;
      const verdict = policy.beforeChannel({
        runId: ctx.runId,
        channelId,
        isSynthesis,
        recursionDepth: depth,
        completedChannels: [...result.channels],
      });
      await this.recordPolicyDecision(result, {
        policyId: policy.policyId,
        hook: "beforeChannel",
        channelId,
        decision: verdict.decision,
        reason: verdict.reason,
      });
      if (verdict.decision === "abort") {
        onHalt();
        controller.abort();
        return null;
      }
      if (verdict.decision === "skip") {
        return null;
      }
    }

    const channelResult = await this.runOne(planned, ctx);

    // afterChannel hooks (registration order). The just-produced result is part
    // of "completed channels" for cumulative-cost policies.
    const completedWithThis = [...result.channels, channelResult];
    for (const policy of this.policies) {
      if (!policy.afterChannel) continue;
      const verdict = policy.afterChannel({
        runId: ctx.runId,
        channelId,
        isSynthesis,
        recursionDepth: depth,
        channelResult,
        completedChannels: completedWithThis,
      });
      await this.recordPolicyDecision(result, {
        policyId: policy.policyId,
        hook: "afterChannel",
        channelId,
        decision: verdict.decision,
        reason: verdict.reason,
      });
      if (verdict.decision === "halt") {
        onHalt();
        controller.abort();
      }
    }

    return channelResult;
  }

  /** Append a policy decision to the run and emit it as a telemetry attribute. */
  private async recordPolicyDecision(
    result: RunResult,
    record: PolicyDecisionRecord,
  ): Promise<void> {
    const decision: PolicyDecision = {
      policyId: record.policyId,
      hook: record.hook,
      channelId: record.channelId,
      decision: record.decision,
      reason: record.reason,
    };
    result.policy.push(decision);
    await this.safeTelemetry(() =>
      this.telemetry.emit({
        runId: result.runId,
        channelId: record.channelId,
        type: "policy.decision",
        attributes: {
          "policy.id": record.policyId,
          "policy.hook": record.hook,
          "policy.decision": record.decision,
          "policy.reason": record.reason,
        },
        timestamp: new Date().toISOString(),
      }),
    );
  }

  private async runOne(
    planned: PlannedChannel,
    ctx: {
      runId: string;
      input: string;
      channelResults: ChannelResult[];
      previousSynthesis: ChannelResult | null;
      recursionDepth: number;
      resolved: { spec: { id: string; defaults?: PipelineDefaults } };
      promptHashes: Record<string, string>;
      schemaHashes: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
      upstream?: Record<string, { parsed: string; raw: string }>;
    },
  ): Promise<ChannelResult> {
    const channel: ChannelSpec = planned.channel;
    const adapter = this.providers.get(planned.provider.type);

    const promptTemplate = await this.registry.loadPrompt(channel.prompt);
    ctx.promptHashes[channel.id] = sha256(promptTemplate);

    let schema: object | null = null;
    if (channel.outputSchema) {
      const loaded = (await this.registry.loadSchema(channel.outputSchema)) as object;
      schema = loaded;
      ctx.schemaHashes[channel.id] = sha256(canonicalJson(loaded));
    }
    // (hashing duplicated by recordHashes for carried-forward channels)

    // Resolve effective retry/repair config: channel-level overrides the
    // pipeline default. Repair also honors the legacy `channel.repairAttempts`.
    const defaults = ctx.resolved.spec.defaults;
    const retry = channel.retry ?? defaults?.retry;
    const repair = channel.repair ?? defaults?.repair;

    return executeChannel(planned, {
      adapter,
      renderer: this.renderer,
      validator: this.validator,
      store: this.store,
      runId: ctx.runId,
      promptTemplate,
      schema,
      retry,
      repair,
      context: {
        input: ctx.input,
        channelResults: planned.isSynthesis ? ctx.channelResults : undefined,
        previousSynthesis: ctx.previousSynthesis,
        recursionDepth: ctx.recursionDepth,
        runId: ctx.runId,
        upstream: ctx.upstream,
      },
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
    });
  }

  /** Record a channel's prompt/schema hashes without executing it. */
  private async recordHashes(
    planned: PlannedChannel,
    promptHashes: Record<string, string>,
    schemaHashes: Record<string, string>,
  ): Promise<void> {
    const channel = planned.channel;
    const promptTemplate = await this.registry.loadPrompt(channel.prompt);
    promptHashes[channel.id] = sha256(promptTemplate);
    if (channel.outputSchema) {
      const loaded = (await this.registry.loadSchema(channel.outputSchema)) as object;
      schemaHashes[channel.id] = sha256(canonicalJson(loaded));
    }
  }

  /**
   * Resume a prior partial run. Loads the prior run, re-resolves its pipeline,
   * and verifies the pipeline/prompt/schema hashes match the prior run. On a
   * hash mismatch it throws a {@link ResumeHashMismatchError} (the caller maps
   * it to a structured refusal). Completed channels are carried forward
   * unchanged; only not-completed channels are re-executed.
   */
  async resume(priorRunId: string, signal?: AbortSignal): Promise<RunResult> {
    const prior = await this.store.getRun(priorRunId);
    if (!prior) {
      throw new ResumeError(`run not found: ${priorRunId}`, "run_not_found");
    }

    const resolved = await this.registry.resolvePipeline(prior.pipelineId);

    // Verify the pipeline hash is unchanged.
    const mismatches: string[] = [];
    if (resolved.pipelineHash !== prior.source.pipelineHash) {
      mismatches.push(
        `pipelineHash: prior=${prior.source.pipelineHash} current=${resolved.pipelineHash}`,
      );
    }

    // Verify prompt + schema hashes for every channel recorded in the prior run.
    const plan = buildExecutionPlan(resolved.spec);
    const allPlanned = [...plan.channels, ...(plan.synthesis ? [plan.synthesis] : [])];
    const plannedById = new Map(allPlanned.map((p) => [p.channel.id, p]));
    for (const [channelId, priorPromptHash] of Object.entries(prior.source.promptHashes)) {
      const planned = plannedById.get(channelId);
      if (!planned) {
        mismatches.push(`promptHash[${channelId}]: channel no longer in pipeline`);
        continue;
      }
      const currentPrompt = await this.registry.loadPrompt(planned.channel.prompt);
      const currentHash = sha256(currentPrompt);
      if (currentHash !== priorPromptHash) {
        mismatches.push(
          `promptHash[${channelId}]: prior=${priorPromptHash} current=${currentHash}`,
        );
      }
    }
    for (const [channelId, priorSchemaHash] of Object.entries(prior.source.schemaHashes)) {
      const planned = plannedById.get(channelId);
      if (!planned || !planned.channel.outputSchema) {
        mismatches.push(`schemaHash[${channelId}]: channel/schema no longer in pipeline`);
        continue;
      }
      const loaded = (await this.registry.loadSchema(planned.channel.outputSchema)) as object;
      const currentHash = sha256(canonicalJson(loaded));
      if (currentHash !== priorSchemaHash) {
        mismatches.push(
          `schemaHash[${channelId}]: prior=${priorSchemaHash} current=${currentHash}`,
        );
      }
    }

    if (mismatches.length > 0) {
      throw new ResumeError(
        `refusing to resume ${priorRunId}: pipeline definition changed`,
        "hash_mismatch",
        mismatches,
      );
    }

    // Carry forward only the channels that completed successfully (status "ok").
    const completed = prior.channels.filter((c) => c.status === "ok");

    return this.run({ pipelineId: prior.pipelineId, input: prior.input }, signal, {
      resumedFrom: priorRunId,
      channels: completed,
    });
  }

  private async safeTelemetry<T>(fn: () => Promise<T>, fallback?: T): Promise<T | undefined> {
    try {
      return await fn();
    } catch {
      // Observational plugin: telemetry failures never fail the run.
      return fallback;
    }
  }
}

export type ResumeErrorCode = "run_not_found" | "hash_mismatch";

/** Structured error raised when a resume cannot proceed. */
export class ResumeError extends Error {
  constructor(
    message: string,
    readonly code: ResumeErrorCode,
    readonly mismatches: string[] = [],
  ) {
    super(message);
    this.name = "ResumeError";
  }
  /** A JSON-serializable structured representation for REST/MCP responses. */
  toStructured(): { error: string; code: ResumeErrorCode; mismatches: string[] } {
    return { error: this.message, code: this.code, mismatches: this.mismatches };
  }
}

function totalCost(result: RunResult): number | null {
  let sum = 0;
  let any = false;
  const all = [...result.channels];
  if (result.synthesis) all.push(result.synthesis);
  for (const c of all) {
    if (typeof c.usage.costUsd === "number") {
      sum += c.usage.costUsd;
      any = true;
    }
  }
  return any ? sum : null;
}
