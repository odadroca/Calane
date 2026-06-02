import type { ChannelResult, RunResult } from "../specs/RunResult.js";

/**
 * RunDiffer — a structural and content diff between two RunResults of the SAME
 * pipeline. It is schema-agnostic: the key-level diff walks parsed outputs
 * generically (objects/arrays/scalars) rather than depending on a particular
 * channel schema. Free-text semantic diffing is explicitly out of scope (only
 * structural and key-level changes are reported).
 *
 * Diffing two runs of different pipelines is refused: their channel sets and
 * schemas are not comparable, so a key-level diff would be meaningless. The
 * refusal is surfaced as `comparable: false` with an explanation.
 */

/** A single changed scalar/leaf at a JSON path within a channel's parsed output. */
export interface KeyLevelChange {
  /** Dotted/bracketed JSON path, e.g. `summary.score` or `items[2].name`. */
  path: string;
  kind: "added" | "removed" | "changed";
  a: unknown;
  b: unknown;
}

/** Per-field comparison of a single channel that appears in both runs. */
export interface ChannelFieldDiff {
  status: { a: string; b: string; changed: boolean };
  schemaValid: { a: boolean; b: boolean; changed: boolean };
  provider: { a: string; b: string; changed: boolean };
  model: { a: string | null; b: string | null; changed: boolean };
  costUsd: { a: number | null; b: number | null; delta: number | null };
  latencyMs: { a: number; b: number; delta: number };
  /** Schema-aware key-level diff of parsed output. Empty when identical. */
  parsedChanges: KeyLevelChange[];
}

export interface ChannelDiff {
  channelId: string;
  /** "both" when present in both runs; otherwise present only in a or b. */
  presence: "both" | "only_a" | "only_b";
  /** Field-level diff; present only when the channel is in both runs. */
  fields?: ChannelFieldDiff;
}

export interface RunDiff {
  comparable: boolean;
  /** Populated only when `comparable` is false. */
  reason?: string;
  runA: string;
  runB: string;
  pipelineId: string;
  pipelineHash: string;
  status: { a: string; b: string; changed: boolean };
  validationValid: { a: boolean; b: boolean; changed: boolean };
  totalCostUsd: { a: number | null; b: number | null; delta: number | null };
  /** All channel ids seen across both runs (channels + synthesis), sorted. */
  channels: ChannelDiff[];
  /** True when nothing changed across status, validation, and every channel. */
  identical: boolean;
}

/** Flatten a RunResult's channels plus synthesis into a single id-keyed map. */
function channelMap(result: RunResult): Map<string, ChannelResult> {
  const m = new Map<string, ChannelResult>();
  for (const c of result.channels) m.set(c.channelId, c);
  if (result.synthesis) m.set(result.synthesis.channelId, result.synthesis);
  return m;
}

function totalCost(result: RunResult): number | null {
  let sum = 0;
  let any = false;
  for (const c of channelMap(result).values()) {
    if (typeof c.usage.costUsd === "number") {
      sum += c.usage.costUsd;
      any = true;
    }
  }
  return any ? sum : null;
}

function deltaNullable(a: number | null, b: number | null): number | null {
  if (typeof a === "number" && typeof b === "number") return b - a;
  return null;
}

/**
 * Schema-aware key-level diff of two parsed outputs. Walks objects and arrays
 * recursively; reports added/removed/changed leaves by JSON path. Two values
 * are "changed" when their canonical JSON differs at a leaf. Arrays are
 * compared positionally (index-aligned), which is the structural contract for
 * schema-validated outputs.
 */
export function diffParsed(a: unknown, b: unknown, base = "$"): KeyLevelChange[] {
  const changes: KeyLevelChange[] = [];
  walk(a, b, base, changes);
  return changes;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function walk(a: unknown, b: unknown, path: string, out: KeyLevelChange[]): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      const childPath = path === "$" ? key : `${path}.${key}`;
      const hasA = Object.hasOwn(a, key);
      const hasB = Object.hasOwn(b, key);
      if (hasA && !hasB) {
        out.push({ path: childPath, kind: "removed", a: a[key], b: undefined });
      } else if (!hasA && hasB) {
        out.push({ path: childPath, kind: "added", a: undefined, b: b[key] });
      } else {
        walk(a[key], b[key], childPath, out);
      }
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const childPath = `${path}[${i}]`;
      const hasA = i < a.length;
      const hasB = i < b.length;
      if (hasA && !hasB) {
        out.push({ path: childPath, kind: "removed", a: a[i], b: undefined });
      } else if (!hasA && hasB) {
        out.push({ path: childPath, kind: "added", a: undefined, b: b[i] });
      } else {
        walk(a[i], b[i], childPath, out);
      }
    }
    return;
  }
  // Leaf comparison (covers scalar-vs-scalar and mismatched container shapes).
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path, kind: "changed", a, b });
  }
}

function diffChannel(a: ChannelResult, b: ChannelResult): ChannelFieldDiff {
  return {
    status: { a: a.status, b: b.status, changed: a.status !== b.status },
    schemaValid: { a: a.schemaValid, b: b.schemaValid, changed: a.schemaValid !== b.schemaValid },
    provider: { a: a.provider, b: b.provider, changed: a.provider !== b.provider },
    model: { a: a.model, b: b.model, changed: a.model !== b.model },
    costUsd: {
      a: a.usage.costUsd,
      b: b.usage.costUsd,
      delta: deltaNullable(a.usage.costUsd, b.usage.costUsd),
    },
    latencyMs: { a: a.latencyMs, b: b.latencyMs, delta: b.latencyMs - a.latencyMs },
    parsedChanges: diffParsed(a.parsedOutput, b.parsedOutput),
  };
}

/** Structured error raised when two runs cannot be diffed. */
export class RunDiffError extends Error {
  constructor(
    message: string,
    readonly code: "pipeline_mismatch",
    readonly detail: { a: string; b: string },
  ) {
    super(message);
    this.name = "RunDiffError";
  }
  toStructured() {
    return { error: this.message, code: this.code, detail: this.detail };
  }
}

/**
 * Diff two runs. Throws {@link RunDiffError} when the pipeline hashes differ
 * (refuse-to-diff). Callers that prefer a value over an exception can use
 * {@link tryDiffRuns}.
 */
export function diffRuns(a: RunResult, b: RunResult): RunDiff {
  if (a.source.pipelineHash !== b.source.pipelineHash) {
    throw new RunDiffError(
      `refusing to diff runs of different pipeline definitions: ${a.runId} (pipelineHash=${a.source.pipelineHash}) vs ${b.runId} (pipelineHash=${b.source.pipelineHash}). Diffs are only meaningful between runs of the same pipeline.`,
      "pipeline_mismatch",
      { a: a.source.pipelineHash, b: b.source.pipelineHash },
    );
  }

  const mapA = channelMap(a);
  const mapB = channelMap(b);
  const ids = [...new Set([...mapA.keys(), ...mapB.keys()])].sort();

  const channels: ChannelDiff[] = ids.map((channelId) => {
    const ca = mapA.get(channelId);
    const cb = mapB.get(channelId);
    if (ca && cb) {
      return { channelId, presence: "both", fields: diffChannel(ca, cb) };
    }
    return { channelId, presence: ca ? "only_a" : "only_b" };
  });

  const statusChanged = a.status !== b.status;
  const validationChanged = a.validation.valid !== b.validation.valid;
  const anyChannelChanged = channels.some(
    (c) =>
      c.presence !== "both" ||
      (c.fields &&
        (c.fields.status.changed ||
          c.fields.schemaValid.changed ||
          c.fields.provider.changed ||
          c.fields.model.changed ||
          c.fields.parsedChanges.length > 0)),
  );

  const ta = totalCost(a);
  const tb = totalCost(b);

  return {
    comparable: true,
    runA: a.runId,
    runB: b.runId,
    pipelineId: a.pipelineId,
    pipelineHash: a.source.pipelineHash,
    status: { a: a.status, b: b.status, changed: statusChanged },
    validationValid: { a: a.validation.valid, b: b.validation.valid, changed: validationChanged },
    totalCostUsd: { a: ta, b: tb, delta: deltaNullable(ta, tb) },
    channels,
    identical: !statusChanged && !validationChanged && !anyChannelChanged,
  };
}

/**
 * Non-throwing variant: returns a `comparable: false` RunDiff-like shape on a
 * pipeline mismatch (used by REST/CLI to render a clean refusal).
 */
export function tryDiffRuns(a: RunResult, b: RunResult): RunDiff {
  try {
    return diffRuns(a, b);
  } catch (err) {
    if (err instanceof RunDiffError) {
      return {
        comparable: false,
        reason: err.message,
        runA: a.runId,
        runB: b.runId,
        pipelineId: a.pipelineId,
        pipelineHash: a.source.pipelineHash,
        status: { a: a.status, b: b.status, changed: a.status !== b.status },
        validationValid: {
          a: a.validation.valid,
          b: b.validation.valid,
          changed: a.validation.valid !== b.validation.valid,
        },
        totalCostUsd: { a: null, b: null, delta: null },
        channels: [],
        identical: false,
      };
    }
    throw err;
  }
}

function fmt(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Render a RunDiff as human-readable markdown. */
export function renderDiffMarkdown(diff: RunDiff): string {
  if (!diff.comparable) {
    return [
      `# Run diff: ${diff.runA} vs ${diff.runB}`,
      "",
      "**Not comparable.**",
      "",
      diff.reason ?? "Runs are not comparable.",
      "",
    ].join("\n");
  }

  const lines: string[] = [
    `# Run diff: ${diff.runA} vs ${diff.runB}`,
    "",
    `- Pipeline: \`${diff.pipelineId}\` (hash \`${diff.pipelineHash}\`)`,
    `- Identical: ${diff.identical ? "yes" : "no"}`,
    "",
    "## Run-level",
    "",
    "| Field | A | B | Changed |",
    "| --- | --- | --- | --- |",
    `| status | ${diff.status.a} | ${diff.status.b} | ${diff.status.changed ? "yes" : "no"} |`,
    `| validation.valid | ${diff.validationValid.a} | ${diff.validationValid.b} | ${diff.validationValid.changed ? "yes" : "no"} |`,
    `| total cost (USD) | ${fmt(diff.totalCostUsd.a)} | ${fmt(diff.totalCostUsd.b)} | ${diff.totalCostUsd.delta === null ? "—" : `Δ ${diff.totalCostUsd.delta}`} |`,
    "",
    "## Channels",
    "",
  ];

  for (const ch of diff.channels) {
    lines.push(`### ${ch.channelId}`, "");
    if (ch.presence !== "both") {
      lines.push(`Present only in run ${ch.presence === "only_a" ? "A" : "B"}.`, "");
      continue;
    }
    const f = ch.fields;
    if (!f) continue;
    lines.push(
      "| Field | A | B | Changed |",
      "| --- | --- | --- | --- |",
      `| status | ${f.status.a} | ${f.status.b} | ${f.status.changed ? "yes" : "no"} |`,
      `| schemaValid | ${f.schemaValid.a} | ${f.schemaValid.b} | ${f.schemaValid.changed ? "yes" : "no"} |`,
      `| provider | ${f.provider.a} | ${f.provider.b} | ${f.provider.changed ? "yes" : "no"} |`,
      `| model | ${fmt(f.model.a)} | ${fmt(f.model.b)} | ${f.model.changed ? "yes" : "no"} |`,
      `| cost (USD) | ${fmt(f.costUsd.a)} | ${fmt(f.costUsd.b)} | ${f.costUsd.delta === null ? "—" : `Δ ${f.costUsd.delta}`} |`,
      `| latency (ms) | ${f.latencyMs.a} | ${f.latencyMs.b} | Δ ${f.latencyMs.delta} |`,
      "",
    );
    if (f.parsedChanges.length === 0) {
      lines.push("_Parsed output: no key-level changes._", "");
    } else {
      lines.push(
        "Parsed output changes:",
        "",
        "| Path | Kind | A | B |",
        "| --- | --- | --- | --- |",
      );
      for (const c of f.parsedChanges) {
        lines.push(`| \`${c.path}\` | ${c.kind} | ${fmt(c.a)} | ${fmt(c.b)} |`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
