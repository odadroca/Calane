import type { ChannelResult, RunResult } from "../specs/RunResult.js";

/**
 * StatsQueries — cross-run aggregate queries over a corpus of RunResults.
 *
 * These aggregates are computed in-process over the canonical RunResult objects
 * supplied by the caller. The intended (and only supported) data source is the
 * SQLite result store: its indexed `runs` table materializes RunResults cheaply
 * in a single file, so feeding `listRuns()`/`getRun()` output here is fast. The
 * filesystem store is explicitly NOT supported for aggregation (one disk read
 * per run); the CLI/REST layer detects a non-SQLite store and returns the
 * structured {@link statsUnsupportedError} instead of calling these functions.
 *
 * This module is deliberately storage-agnostic and dependency-free (no SQL, no
 * better-sqlite3 import in core): it takes RunResults and returns plain JSON.
 */

/** A clear, structured error returned when stats are requested on a non-SQLite store. */
export interface StatsUnsupportedError {
  error: string;
  code: "stats_requires_sqlite";
  storeName: string;
}

/**
 * Build the structured "stats require SQLite" error. The CLI and REST layers
 * call this when the active store is not the SQLite store.
 */
export function statsUnsupportedError(storeName: string): StatsUnsupportedError {
  return {
    error: `cross-run stats require the SQLite result store; the active store is "${storeName}". Re-run with the SQLite store (CLI: --store sqlite[:<path>]) — the filesystem store is not supported for aggregation because it would require one disk read per run.`,
    code: "stats_requires_sqlite",
    storeName,
  };
}

/** Inclusive time window over `startedAt` (ISO-8601). Either bound is optional. */
export interface TimeRange {
  after?: string;
  before?: string;
}

function allChannels(run: RunResult): ChannelResult[] {
  const all = [...run.channels];
  if (run.synthesis) all.push(run.synthesis);
  return all;
}

function inRange(run: RunResult, range?: TimeRange): boolean {
  if (!range) return true;
  if (range.after !== undefined && run.startedAt < range.after) return false;
  if (range.before !== undefined && run.startedAt > range.before) return false;
  return true;
}

function runCost(run: RunResult): number {
  let sum = 0;
  for (const c of allChannels(run)) {
    if (typeof c.usage.costUsd === "number") sum += c.usage.costUsd;
  }
  return sum;
}

/** One time-bucket of cost aggregation. */
export interface CostBucket {
  /** Bucket key: the calendar day (YYYY-MM-DD) of `startedAt`. */
  day: string;
  runs: number;
  totalCostUsd: number;
}

export interface CostStats {
  pipelineId: string | null;
  range: TimeRange | null;
  totalRuns: number;
  totalCostUsd: number;
  buckets: CostBucket[];
}

/**
 * Cost over time, bucketed by calendar day. Optionally filtered to a single
 * pipeline and/or a time range.
 */
export function costStats(
  runs: RunResult[],
  opts: { pipelineId?: string; range?: TimeRange } = {},
): CostStats {
  const filtered = runs.filter(
    (r) =>
      (opts.pipelineId === undefined || r.pipelineId === opts.pipelineId) && inRange(r, opts.range),
  );
  const byDay = new Map<string, CostBucket>();
  let total = 0;
  for (const r of filtered) {
    const day = r.startedAt.slice(0, 10);
    const cost = runCost(r);
    total += cost;
    const bucket = byDay.get(day) ?? { day, runs: 0, totalCostUsd: 0 };
    bucket.runs += 1;
    bucket.totalCostUsd += cost;
    byDay.set(day, bucket);
  }
  return {
    pipelineId: opts.pipelineId ?? null,
    range: opts.range ?? null,
    totalRuns: filtered.length,
    totalCostUsd: total,
    buckets: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/** Per-provider latency aggregation. */
export interface ProviderLatency {
  provider: string;
  samples: number;
  totalLatencyMs: number;
  meanLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
}

export interface LatencyStats {
  provider: string | null;
  range: TimeRange | null;
  providers: ProviderLatency[];
}

/**
 * Latency by provider, aggregated across every channel of every (filtered) run.
 * Optionally filtered to a single provider and/or a time range.
 */
export function latencyStats(
  runs: RunResult[],
  opts: { provider?: string; range?: TimeRange } = {},
): LatencyStats {
  const acc = new Map<string, { samples: number; total: number; min: number; max: number }>();
  for (const r of runs) {
    if (!inRange(r, opts.range)) continue;
    for (const c of allChannels(r)) {
      if (opts.provider !== undefined && c.provider !== opts.provider) continue;
      const a = acc.get(c.provider) ?? {
        samples: 0,
        total: 0,
        min: Number.POSITIVE_INFINITY,
        max: 0,
      };
      a.samples += 1;
      a.total += c.latencyMs;
      a.min = Math.min(a.min, c.latencyMs);
      a.max = Math.max(a.max, c.latencyMs);
      acc.set(c.provider, a);
    }
  }
  const providers: ProviderLatency[] = [...acc.entries()]
    .map(([provider, a]) => ({
      provider,
      samples: a.samples,
      totalLatencyMs: a.total,
      meanLatencyMs: a.samples > 0 ? a.total / a.samples : 0,
      minLatencyMs: a.samples > 0 ? a.min : 0,
      maxLatencyMs: a.max,
    }))
    .sort((x, y) => y.meanLatencyMs - x.meanLatencyMs);
  return { provider: opts.provider ?? null, range: opts.range ?? null, providers };
}

/** Per-pipeline validation-failure aggregation. */
export interface PipelineFailureRate {
  pipelineId: string;
  totalRuns: number;
  invalidRuns: number;
  failureRate: number;
}

/** A channel id that failed (non-`ok` status) and how often. */
export interface FailedChannel {
  channelId: string;
  failures: number;
}

export interface FailureStats {
  range: TimeRange | null;
  byPipeline: PipelineFailureRate[];
  topFailedChannels: FailedChannel[];
}

/**
 * Validation failure rate by pipeline plus the most-frequently-failing channels
 * (channels whose status is not `ok`). Optionally filtered to a time range.
 */
export function failureStats(
  runs: RunResult[],
  opts: { range?: TimeRange; topN?: number } = {},
): FailureStats {
  const byPipeline = new Map<string, { total: number; invalid: number }>();
  const channelFailures = new Map<string, number>();
  for (const r of runs) {
    if (!inRange(r, opts.range)) continue;
    const p = byPipeline.get(r.pipelineId) ?? { total: 0, invalid: 0 };
    p.total += 1;
    if (!r.validation.valid) p.invalid += 1;
    byPipeline.set(r.pipelineId, p);
    for (const c of allChannels(r)) {
      if (c.status !== "ok") {
        channelFailures.set(c.channelId, (channelFailures.get(c.channelId) ?? 0) + 1);
      }
    }
  }
  const topN = opts.topN ?? 10;
  return {
    range: opts.range ?? null,
    byPipeline: [...byPipeline.entries()]
      .map(([pipelineId, v]) => ({
        pipelineId,
        totalRuns: v.total,
        invalidRuns: v.invalid,
        failureRate: v.total > 0 ? v.invalid / v.total : 0,
      }))
      .sort((a, b) => b.failureRate - a.failureRate),
    topFailedChannels: [...channelFailures.entries()]
      .map(([channelId, failures]) => ({ channelId, failures }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, topN),
  };
}

// --- ASCII table rendering (hand-rolled; no table library) -----------------

/** Render a simple fixed-width ASCII table. Columns are left-aligned. */
export function renderAsciiTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`;
  const fmtRow = (cells: string[]) =>
    `| ${cells.map((c, i) => pad(c ?? "", widths[i] ?? 0)).join(" | ")} |`;
  const lines = [sep, fmtRow(headers), sep];
  for (const r of rows) lines.push(fmtRow(r));
  lines.push(sep);
  return lines.join("\n");
}

function num(n: number, digits = 4): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

/** Render cost stats as an ASCII table. */
export function renderCostTable(stats: CostStats): string {
  const rows = stats.buckets.map((b) => [b.day, String(b.runs), num(b.totalCostUsd)]);
  rows.push(["TOTAL", String(stats.totalRuns), num(stats.totalCostUsd)]);
  const scope = stats.pipelineId ? `pipeline=${stats.pipelineId}` : "all pipelines";
  return `Cost over time (${scope})\n${renderAsciiTable(["day", "runs", "cost_usd"], rows)}`;
}

/** Render latency stats as an ASCII table. */
export function renderLatencyTable(stats: LatencyStats): string {
  const rows = stats.providers.map((p) => [
    p.provider,
    String(p.samples),
    num(p.meanLatencyMs, 1),
    num(p.minLatencyMs, 1),
    num(p.maxLatencyMs, 1),
  ]);
  return `Latency by provider\n${renderAsciiTable(
    ["provider", "samples", "mean_ms", "min_ms", "max_ms"],
    rows,
  )}`;
}

/** Render failure stats as two ASCII tables. */
export function renderFailureTable(stats: FailureStats): string {
  const pipelineRows = stats.byPipeline.map((p) => [
    p.pipelineId,
    String(p.totalRuns),
    String(p.invalidRuns),
    num(p.failureRate * 100, 1),
  ]);
  const channelRows = stats.topFailedChannels.map((c) => [c.channelId, String(c.failures)]);
  return [
    "Validation failure rate by pipeline",
    renderAsciiTable(["pipeline", "runs", "invalid", "fail_pct"], pipelineRows),
    "",
    "Top failed channels",
    renderAsciiTable(["channel", "failures"], channelRows),
  ].join("\n");
}
