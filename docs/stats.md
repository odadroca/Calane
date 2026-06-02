# Cross-run aggregate queries

Phase 5 treats the corpus of runs as a first-class object. The `stats` queries
summarize cost, latency, and validation failures across many runs. This is a
CLI + REST feature only — it does **not** add to the 8-tool MCP/openai surface.

## SQLite-only

Aggregation is supported **only on the SQLite result store**. The filesystem
store would require one disk read per run, which does not scale; requesting
stats on a filesystem store returns a clear, structured error instead:

```json
{
  "error": "cross-run stats require the SQLite result store; the active store is \"filesystem\". ...",
  "code": "stats_requires_sqlite",
  "storeName": "filesystem"
}
```

The aggregates themselves are computed in `@llm-pipe/core`
(`packages/core/src/stats/StatsQueries.ts`) over the canonical RunResult objects
materialized by the SQLite store's indexed `runs` table. No new dependency is
introduced — better-sqlite3 already backs the store.

## Queries

- **cost** — total cost bucketed by calendar day; optional `--pipeline` filter
  and `--range` window.
- **latency** — per-provider mean/min/max latency across all channels; optional
  `--provider` filter and `--range` window.
- **failures** — validation failure rate by pipeline plus the most-frequently
  failing channels (channels whose status is not `ok`).

## CLI

Stats commands require the SQLite store, so pass `--store sqlite[:<path>]`:

```sh
llm-pipe --store sqlite:.runs/runs.sqlite stats cost --pipeline swot --range 7d
llm-pipe --store sqlite:.runs/runs.sqlite stats latency --provider openai
llm-pipe --store sqlite:.runs/runs.sqlite stats failures --top 5
```

Output is a plain ASCII table by default; pass `--json` for the raw structured
result. `--range` accepts a relative window (`7d`, `24h`) or an ISO-8601 lower
bound.

## REST

```
GET /stats/cost?pipeline=<id>&range=<window>
GET /stats/latency?provider=<id>&range=<window>
GET /stats/failures?range=<window>&top=<n>
```

Returns the structured JSON result. When the server is backed by a non-SQLite
store, these endpoints respond `409` with the `stats_requires_sqlite` body.

## Out of scope

- Dashboards.
- Alerting.
- Real-time streaming.
