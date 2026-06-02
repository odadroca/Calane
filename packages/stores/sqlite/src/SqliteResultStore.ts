import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ResultStoreInterface, RunResult } from "@llm-pipe/core";
import Database from "better-sqlite3";

/**
 * Optional filters for {@link SqliteResultStore.listRunsFiltered}. All filters
 * are AND-combined. Time-range filters compare against the run's `startedAt`
 * ISO-8601 timestamp (lexicographic comparison is correct for ISO-8601 UTC).
 */
export interface RunListFilter {
  pipelineId?: string;
  status?: RunResult["status"];
  /** Inclusive lower bound on `startedAt` (ISO-8601). */
  startedAfter?: string;
  /** Inclusive upper bound on `startedAt` (ISO-8601). */
  startedBefore?: string;
}

/**
 * SQLite-backed result store, an alternative to the filesystem store. The
 * filesystem store remains the default; this store is for callers who want
 * queryable run history (filter by pipeline, status, time range) in a single
 * file or in memory.
 *
 * The canonical RunResult JSON is stored verbatim in `runs.result_json`, so a
 * round-trip is byte-for-byte faithful to the RunResult shape. The `channels`,
 * `validation_errors`, and `usage` tables are denormalized projections used for
 * indexed querying; they never become the source of truth for `getRun`.
 *
 * Raw provider outputs are stored as TEXT in `raw_outputs`. Parsed outputs are
 * persisted as TEXT inside the run JSON and additionally projected into the
 * `channels` table as `parsed_output` TEXT.
 */
export class SqliteResultStore implements ResultStoreInterface {
  readonly name = "sqlite";
  private readonly db: Database.Database;

  /**
   * @param path Filesystem path to the SQLite database, or ":memory:" for an
   * ephemeral in-process database (useful for tests).
   */
  constructor(path = ":memory:") {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Idempotent schema migration. Safe to call on every construction. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id        TEXT PRIMARY KEY,
        pipeline_id   TEXT NOT NULL,
        status        TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        completed_at  TEXT,
        result_json   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_pipeline ON runs (pipeline_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_pipeline_status_started
        ON runs (pipeline_id, status, started_at);

      CREATE TABLE IF NOT EXISTS channels (
        run_id          TEXT NOT NULL,
        channel_id      TEXT NOT NULL,
        is_synthesis    INTEGER NOT NULL DEFAULT 0,
        provider        TEXT NOT NULL,
        model           TEXT,
        status          TEXT NOT NULL,
        schema_valid    INTEGER NOT NULL,
        latency_ms      INTEGER NOT NULL,
        raw_output_ref  TEXT,
        parsed_output   TEXT,
        FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_channels_run ON channels (run_id);
      CREATE INDEX IF NOT EXISTS idx_channels_status ON channels (status);

      CREATE TABLE IF NOT EXISTS validation_errors (
        run_id      TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        error_json  TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_validation_errors_run ON validation_errors (run_id);

      CREATE TABLE IF NOT EXISTS usage (
        run_id        TEXT NOT NULL,
        channel_id    TEXT NOT NULL,
        is_synthesis  INTEGER NOT NULL DEFAULT 0,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        cost_usd      REAL,
        FOREIGN KEY (run_id) REFERENCES runs (run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_usage_run ON usage (run_id);

      CREATE TABLE IF NOT EXISTS raw_outputs (
        run_id      TEXT NOT NULL,
        ref         TEXT NOT NULL,
        raw         TEXT NOT NULL,
        PRIMARY KEY (run_id, ref)
      );
    `);
  }

  async saveRun(result: RunResult): Promise<void> {
    const tx = this.db.transaction((r: RunResult) => {
      this.db
        .prepare(
          `INSERT INTO runs (run_id, pipeline_id, status, started_at, completed_at, result_json)
           VALUES (@run_id, @pipeline_id, @status, @started_at, @completed_at, @result_json)
           ON CONFLICT(run_id) DO UPDATE SET
             pipeline_id  = excluded.pipeline_id,
             status       = excluded.status,
             started_at   = excluded.started_at,
             completed_at = excluded.completed_at,
             result_json  = excluded.result_json`,
        )
        .run({
          run_id: r.runId,
          pipeline_id: r.pipelineId,
          status: r.status,
          started_at: r.startedAt,
          completed_at: r.completedAt,
          result_json: JSON.stringify(r),
        });

      // Re-project denormalized tables for this run.
      this.db.prepare("DELETE FROM channels WHERE run_id = ?").run(r.runId);
      this.db.prepare("DELETE FROM validation_errors WHERE run_id = ?").run(r.runId);
      this.db.prepare("DELETE FROM usage WHERE run_id = ?").run(r.runId);

      const insChannel = this.db.prepare(
        `INSERT INTO channels
           (run_id, channel_id, is_synthesis, provider, model, status, schema_valid, latency_ms, raw_output_ref, parsed_output)
         VALUES (@run_id, @channel_id, @is_synthesis, @provider, @model, @status, @schema_valid, @latency_ms, @raw_output_ref, @parsed_output)`,
      );
      const insError = this.db.prepare(
        "INSERT INTO validation_errors (run_id, channel_id, error_json) VALUES (?, ?, ?)",
      );
      const insUsage = this.db.prepare(
        `INSERT INTO usage (run_id, channel_id, is_synthesis, input_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );

      const channels = [
        ...r.channels.map((c) => ({ c, synthesis: 0 })),
        ...(r.synthesis ? [{ c: r.synthesis, synthesis: 1 }] : []),
      ];
      for (const { c, synthesis } of channels) {
        insChannel.run({
          run_id: r.runId,
          channel_id: c.channelId,
          is_synthesis: synthesis,
          provider: c.provider,
          model: c.model,
          status: c.status,
          schema_valid: c.schemaValid ? 1 : 0,
          latency_ms: Math.round(c.latencyMs),
          raw_output_ref: c.rawOutputRef,
          parsed_output: c.parsedOutput === undefined ? null : JSON.stringify(c.parsedOutput),
        });
        for (const err of c.validationErrors) {
          insError.run(r.runId, c.channelId, JSON.stringify(err));
        }
        insUsage.run(
          r.runId,
          c.channelId,
          synthesis,
          c.usage.inputTokens,
          c.usage.outputTokens,
          c.usage.costUsd,
        );
      }
    });
    tx(result);
  }

  async getRun(runId: string): Promise<RunResult | null> {
    const row = this.db.prepare("SELECT result_json FROM runs WHERE run_id = ?").get(runId) as
      | { result_json: string }
      | undefined;
    return row ? (JSON.parse(row.result_json) as RunResult) : null;
  }

  async listRuns(): Promise<string[]> {
    const rows = this.db.prepare("SELECT run_id FROM runs ORDER BY started_at DESC").all() as {
      run_id: string;
    }[];
    return rows.map((r) => r.run_id);
  }

  /**
   * List run ids filtered by pipeline id, status, and/or a `startedAt` range.
   * This is a SQLite-store extension beyond the base ResultStoreInterface; the
   * shared interface's {@link listRuns} remains unfiltered.
   */
  async listRunsFiltered(filter: RunListFilter = {}): Promise<string[]> {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.pipelineId !== undefined) {
      clauses.push("pipeline_id = @pipelineId");
      params.pipelineId = filter.pipelineId;
    }
    if (filter.status !== undefined) {
      clauses.push("status = @status");
      params.status = filter.status;
    }
    if (filter.startedAfter !== undefined) {
      clauses.push("started_at >= @startedAfter");
      params.startedAfter = filter.startedAfter;
    }
    if (filter.startedBefore !== undefined) {
      clauses.push("started_at <= @startedBefore");
      params.startedBefore = filter.startedBefore;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT run_id FROM runs ${where} ORDER BY started_at DESC`)
      .all(params) as { run_id: string }[];
    return rows.map((r) => r.run_id);
  }

  async saveRawOutput(runId: string, channelKey: string, raw: string): Promise<string> {
    const safeKey = channelKey.replace(/[^a-z0-9._-]/gi, "_");
    const ref = `raw/${safeKey}.txt`;
    this.db
      .prepare(
        `INSERT INTO raw_outputs (run_id, ref, raw) VALUES (?, ?, ?)
         ON CONFLICT(run_id, ref) DO UPDATE SET raw = excluded.raw`,
      )
      .run(runId, ref, raw);
    return ref;
  }

  async getRawOutput(runId: string, rawOutputRef: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT raw FROM raw_outputs WHERE run_id = ? AND ref = ?")
      .get(runId, rawOutputRef) as { raw: string } | undefined;
    return row ? row.raw : null;
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }
}
