import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type RunDiff, diffRuns } from "../diff/RunDiffer.js";
import { buildExecutionPlan } from "../executor/ExecutionPlan.js";
import type { PipelineExecutor } from "../executor/PipelineExecutor.js";
import type { PromptRegistryInterface } from "../plugins/PromptRegistry.js";
import type { ResultStoreInterface } from "../plugins/ResultStore.js";
import type { RunResult } from "../specs/RunResult.js";
import { canonicalJson, sha256 } from "../util/hash.js";

/**
 * Replayer — re-executes a run from its exported bundle directory ALONE.
 *
 * Before executing, it verifies the bundle's recorded source hashes
 * (pipelineHash, promptHashes, schemaHashes from `manifest.json`) against the
 * CURRENT resolution of the same pipeline id from the registry. If any hash
 * differs, the pipeline definition has drifted since the original run and the
 * replay is refused with an explanation of which hash differs.
 *
 * On a clean match it executes the pipeline against the currently configured
 * providers (a fresh, immutable run). The new run's `replayedFrom` points at the
 * original run id, and a diff between original and replay is produced via S17.
 *
 * Only local bundles are supported (no network-fetched replay). Bundle signing
 * verification is a later phase.
 */

interface BundleManifestShape {
  runId: string;
  pipelineId: string;
  source: {
    pipelineHash: string;
    promptHashes: Record<string, string>;
    schemaHashes: Record<string, string>;
  };
}

export type ReplayErrorCode = "bundle_unreadable" | "hash_mismatch";

/** Structured error raised when a replay cannot proceed. */
export class ReplayError extends Error {
  constructor(
    message: string,
    readonly code: ReplayErrorCode,
    readonly mismatches: string[] = [],
  ) {
    super(message);
    this.name = "ReplayError";
  }
  toStructured(): { error: string; code: ReplayErrorCode; mismatches: string[] } {
    return { error: this.message, code: this.code, mismatches: this.mismatches };
  }
}

export interface ReplayResult {
  /** The original run id recorded in the bundle. */
  originalRunId: string;
  /** The freshly produced replay run. */
  replay: RunResult;
  /** Diff between the original (as recorded in the bundle) and the replay. */
  diff: RunDiff;
}

export interface ReplayerDeps {
  registry: PromptRegistryInterface;
  executor: PipelineExecutor;
  /** Optional store, used to load the original run for the diff when available. */
  store?: ResultStoreInterface;
}

export class Replayer {
  private readonly registry: PromptRegistryInterface;
  private readonly executor: PipelineExecutor;
  private readonly store?: ResultStoreInterface;

  constructor(deps: ReplayerDeps) {
    this.registry = deps.registry;
    this.executor = deps.executor;
    this.store = deps.store;
  }

  /**
   * Replay the run captured in the bundle directory at `bundlePath`. Verifies
   * hashes first; throws {@link ReplayError} on an unreadable bundle or a hash
   * mismatch. On success returns the replay run and an auto-diff.
   */
  async replay(bundlePath: string, options?: { providers?: string[] }): Promise<ReplayResult> {
    const { manifest, input } = await this.readBundle(bundlePath);

    // Re-resolve the pipeline by id and recompute current hashes.
    const resolved = await this.registry.resolvePipeline(manifest.pipelineId);
    const mismatches: string[] = [];

    if (resolved.pipelineHash !== manifest.source.pipelineHash) {
      mismatches.push(
        `pipelineHash: bundle=${manifest.source.pipelineHash} current=${resolved.pipelineHash}`,
      );
    }

    const plan = buildExecutionPlan(resolved.spec);
    const allPlanned = [...plan.channels, ...(plan.synthesis ? [plan.synthesis] : [])];
    const plannedById = new Map(allPlanned.map((p) => [p.channel.id, p]));

    for (const [channelId, bundleHash] of Object.entries(manifest.source.promptHashes)) {
      const planned = plannedById.get(channelId);
      if (!planned) {
        mismatches.push(`promptHash[${channelId}]: channel no longer in pipeline`);
        continue;
      }
      const current = sha256(await this.registry.loadPrompt(planned.channel.prompt));
      if (current !== bundleHash) {
        mismatches.push(`promptHash[${channelId}]: bundle=${bundleHash} current=${current}`);
      }
    }

    for (const [channelId, bundleHash] of Object.entries(manifest.source.schemaHashes)) {
      const planned = plannedById.get(channelId);
      if (!planned || !planned.channel.outputSchema) {
        mismatches.push(`schemaHash[${channelId}]: channel/schema no longer in pipeline`);
        continue;
      }
      const loaded = (await this.registry.loadSchema(planned.channel.outputSchema)) as object;
      const current = sha256(canonicalJson(loaded));
      if (current !== bundleHash) {
        mismatches.push(`schemaHash[${channelId}]: bundle=${bundleHash} current=${current}`);
      }
    }

    if (mismatches.length > 0) {
      throw new ReplayError(
        `refusing to replay ${manifest.runId}: pipeline definition has drifted since the original run`,
        "hash_mismatch",
        mismatches,
      );
    }

    // Hashes match — execute a fresh run against currently configured providers.
    const replay = await this.executor.run({
      pipelineId: manifest.pipelineId,
      input,
      options: options?.providers ? { providers: options.providers } : undefined,
    });
    replay.replayedFrom = manifest.runId;
    // Persist the corrected replayedFrom back to the store (the executor saved
    // it without that field set).
    if (this.store) await this.store.saveRun(replay);

    // Build the "original" RunResult for the diff. Prefer the stored original;
    // fall back to a minimal reconstruction from the bundle manifest.
    const original =
      (await this.store?.getRun(manifest.runId)) ?? reconstructFromManifest(manifest);
    const diff = diffRuns(original, replay);

    return { originalRunId: manifest.runId, replay, diff };
  }

  private async readBundle(
    bundlePath: string,
  ): Promise<{ manifest: BundleManifestShape; input: string }> {
    let manifestText: string;
    let input: string;
    try {
      manifestText = await readFile(join(bundlePath, "manifest.json"), "utf8");
      input = await readFile(join(bundlePath, "input.md"), "utf8");
    } catch (err) {
      throw new ReplayError(
        `cannot read bundle at ${bundlePath}: ${String(err)}`,
        "bundle_unreadable",
      );
    }
    let manifest: BundleManifestShape;
    try {
      manifest = JSON.parse(manifestText) as BundleManifestShape;
    } catch (err) {
      throw new ReplayError(
        `bundle manifest.json is not valid JSON: ${String(err)}`,
        "bundle_unreadable",
      );
    }
    if (!manifest?.pipelineId || !manifest.source?.pipelineHash) {
      throw new ReplayError(
        "bundle manifest.json is missing pipelineId or source.pipelineHash",
        "bundle_unreadable",
      );
    }
    return { manifest, input };
  }
}

/**
 * Minimal RunResult reconstruction from a bundle manifest, used only as a diff
 * baseline when the original run is not available in the store. It carries the
 * recorded pipelineHash so the diff comparability check (same-pipeline) holds.
 */
function reconstructFromManifest(manifest: BundleManifestShape): RunResult {
  return {
    runId: manifest.runId,
    pipelineId: manifest.pipelineId,
    status: "completed",
    startedAt: "",
    completedAt: null,
    input: "",
    source: {
      registry: "bundle",
      ref: null,
      commitSha: null,
      pipelineHash: manifest.source.pipelineHash,
      promptHashes: manifest.source.promptHashes,
      schemaHashes: manifest.source.schemaHashes,
    },
    providers: [],
    recursion: { enabled: false, maxDepth: 1, currentDepth: 1, carryForwardStrategy: null },
    channels: [],
    synthesis: null,
    resumedFrom: null,
    replayedFrom: null,
    policy: [],
    validation: { valid: true, errors: [] },
    telemetry: { traceId: null },
    artifacts: { bundlePath: null },
  };
}
