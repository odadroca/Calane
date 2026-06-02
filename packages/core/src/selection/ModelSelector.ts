import type { PipelineExecutor } from "../executor/PipelineExecutor.js";
import type { ChannelResult, RunResult } from "../specs/RunResult.js";

/**
 * ModelSelector — an empirical model-selection harness. It runs the SAME
 * pipeline across several providers, N times each, and ranks the providers on
 * validation pass rate, cost, latency, and structural conformance.
 *
 * This is decision support, NOT a marketplace and NOT runtime provider
 * switching (both explicitly out of scope). It produces a ranked report; acting
 * on it is the operator's choice.
 */

/** Ranking weights. Higher validation/conformance is better; lower cost/latency is better. */
export interface SelectionWeights {
  validation: number;
  conformance: number;
  cost: number;
  latency: number;
}

export const DEFAULT_WEIGHTS: SelectionWeights = {
  validation: 0.4,
  conformance: 0.3,
  cost: 0.15,
  latency: 0.15,
};

/** Aggregated empirical stats for a single provider across its N runs. */
export interface ProviderStats {
  provider: string;
  runs: number;
  /** Fraction of runs whose overall validation passed (0..1). */
  validationPassRate: number;
  /** Fraction of channels (across all runs) with schemaValid true (0..1). */
  structuralConformance: number;
  /** Mean total cost per run (USD); null when no provider reported cost. */
  meanCostUsd: number | null;
  /** Mean total latency per run (ms). */
  meanLatencyMs: number;
  /** Count of runs that threw during execution. */
  errors: number;
  /** Composite weighted score (higher is better). */
  score: number;
}

export interface SelectionReport {
  pipelineId: string;
  runsPerProvider: number;
  weights: SelectionWeights;
  providers: ProviderStats[];
  /** The top-ranked provider id, or null when no provider produced any run. */
  recommendation: string | null;
}

function totalCost(run: RunResult): number | null {
  let sum = 0;
  let any = false;
  const all: ChannelResult[] = [...run.channels];
  if (run.synthesis) all.push(run.synthesis);
  for (const c of all) {
    if (typeof c.usage.costUsd === "number") {
      sum += c.usage.costUsd;
      any = true;
    }
  }
  return any ? sum : null;
}

function totalLatency(run: RunResult): number {
  let sum = 0;
  const all: ChannelResult[] = [...run.channels];
  if (run.synthesis) all.push(run.synthesis);
  for (const c of all) sum += c.latencyMs;
  return sum;
}

function conformance(run: RunResult): { valid: number; total: number } {
  const all: ChannelResult[] = [...run.channels];
  if (run.synthesis) all.push(run.synthesis);
  return { valid: all.filter((c) => c.schemaValid).length, total: all.length };
}

interface RawProviderAgg {
  provider: string;
  runs: number;
  validationPasses: number;
  conformingChannels: number;
  totalChannels: number;
  costSum: number;
  costSamples: number;
  latencySum: number;
  errors: number;
}

export interface ModelSelectorDeps {
  executor: PipelineExecutor;
}

export class ModelSelector {
  private readonly executor: PipelineExecutor;
  constructor(deps: ModelSelectorDeps) {
    this.executor = deps.executor;
  }

  /**
   * Run `pipelineId` against `input` for each provider in `providers`, `runs`
   * times each, and produce a ranked report. A provider that throws on a run is
   * counted as an error for that run (and contributes a validation failure).
   */
  async select(opts: {
    pipelineId: string;
    input: string;
    providers: string[];
    runs: number;
    weights?: Partial<SelectionWeights>;
  }): Promise<SelectionReport> {
    const weights: SelectionWeights = { ...DEFAULT_WEIGHTS, ...opts.weights };
    const runs = Math.max(1, opts.runs);

    const aggs: RawProviderAgg[] = [];
    for (const provider of opts.providers) {
      const agg: RawProviderAgg = {
        provider,
        runs: 0,
        validationPasses: 0,
        conformingChannels: 0,
        totalChannels: 0,
        costSum: 0,
        costSamples: 0,
        latencySum: 0,
        errors: 0,
      };
      for (let i = 0; i < runs; i++) {
        agg.runs += 1;
        let run: RunResult;
        try {
          run = await this.executor.run({
            pipelineId: opts.pipelineId,
            input: opts.input,
            options: { providers: [provider] },
          });
        } catch {
          agg.errors += 1;
          continue;
        }
        if (run.validation.valid) agg.validationPasses += 1;
        const conf = conformance(run);
        agg.conformingChannels += conf.valid;
        agg.totalChannels += conf.total;
        const cost = totalCost(run);
        if (cost !== null) {
          agg.costSum += cost;
          agg.costSamples += 1;
        }
        agg.latencySum += totalLatency(run);
      }
      aggs.push(agg);
    }

    return this.rank(opts.pipelineId, runs, weights, aggs);
  }

  /** Convert raw aggregates into ranked, weighted ProviderStats. */
  private rank(
    pipelineId: string,
    runsPerProvider: number,
    weights: SelectionWeights,
    aggs: RawProviderAgg[],
  ): SelectionReport {
    const stats = aggs.map((a) => {
      const completedRuns = a.runs - a.errors;
      const validationPassRate = a.runs > 0 ? a.validationPasses / a.runs : 0;
      const structuralConformance =
        a.totalChannels > 0 ? a.conformingChannels / a.totalChannels : 0;
      const meanCostUsd = a.costSamples > 0 ? a.costSum / a.costSamples : null;
      const meanLatencyMs = completedRuns > 0 ? a.latencySum / completedRuns : 0;
      return {
        provider: a.provider,
        runs: a.runs,
        validationPassRate,
        structuralConformance,
        meanCostUsd,
        meanLatencyMs,
        errors: a.errors,
        score: 0,
      } satisfies ProviderStats;
    });

    // Normalize cost and latency to [0,1] across providers (lower is better, so
    // we invert). Validation and conformance are already in [0,1] (higher
    // better). A provider with no cost data is treated as cost 0 (best).
    const costs = stats.map((s) => s.meanCostUsd ?? 0);
    const latencies = stats.map((s) => s.meanLatencyMs);
    const maxCost = Math.max(...costs, 0);
    const maxLatency = Math.max(...latencies, 0);

    for (const s of stats) {
      const costScore = maxCost > 0 ? 1 - (s.meanCostUsd ?? 0) / maxCost : 1;
      const latencyScore = maxLatency > 0 ? 1 - s.meanLatencyMs / maxLatency : 1;
      s.score =
        weights.validation * s.validationPassRate +
        weights.conformance * s.structuralConformance +
        weights.cost * costScore +
        weights.latency * latencyScore;
    }

    stats.sort((a, b) => b.score - a.score);
    return {
      pipelineId,
      runsPerProvider,
      weights,
      providers: stats,
      recommendation: stats.length > 0 && stats[0] ? stats[0].provider : null,
    };
  }
}

function num(n: number | null, digits = 4): string {
  return n === null ? "—" : n.toFixed(digits);
}

/** Render a model-selection report as a plain ASCII table plus a recommendation. */
export function renderSelectionTable(report: SelectionReport): string {
  const headers = [
    "rank",
    "provider",
    "score",
    "valid_rate",
    "conform",
    "mean_cost",
    "mean_ms",
    "errors",
  ];
  const rows = report.providers.map((p, i) => [
    String(i + 1),
    p.provider,
    num(p.score, 3),
    num(p.validationPassRate, 2),
    num(p.structuralConformance, 2),
    num(p.meanCostUsd),
    num(p.meanLatencyMs, 1),
    String(p.errors),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const fmtRow = (cells: string[]) =>
    `| ${cells.map((c, i) => pad(c ?? "", widths[i] ?? 0)).join(" | ")} |`;
  const lines = [
    `Model selection for pipeline "${report.pipelineId}" (${report.runsPerProvider} runs/provider)`,
    sep,
    fmtRow(headers),
    sep,
    ...rows.map(fmtRow),
    sep,
    `Recommendation: ${report.recommendation ?? "none (no runs produced)"}`,
  ];
  return lines.join("\n");
}
