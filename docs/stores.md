# Result stores

A result store persists `RunResult` records, raw provider outputs, and parsed
outputs. Every store conforms to `ResultStoreInterface` from `@llm-pipe/core`.
The kernel never assumes a particular backend.

The kernel ships two stores. The **filesystem store is the default.**

## Filesystem store (`@llm-pipe/store-filesystem`)

Persists each run under `<root>/<runId>/`:

- `run.json` — the full `RunResult`.
- `raw/<channelKey>.txt` — raw provider output blobs.

Use the filesystem store when:

- You want human-inspectable, diffable run artifacts on disk.
- You want the simplest possible setup with no native dependencies.
- Run history volume is small, or you query runs by browsing directories.

## SQLite store (`@llm-pipe/store-sqlite`)

Backed by `better-sqlite3` (a synchronous, well-maintained native binding that
keeps the Node 20+ floor; `node:sqlite` would have raised the floor to Node 22).
A single database file (or `:memory:`) holds all runs.

The canonical `RunResult` JSON is stored verbatim in `runs.result_json`, so a
round-trip through the SQLite store is faithful to the `RunResult` shape. The
other tables are **denormalized projections** used purely for indexed querying;
they are never the source of truth for `getRun`.

### Schema

| Table | Purpose | Notable indexes |
|---|---|---|
| `runs` | one row per run; holds canonical `result_json` TEXT | `pipeline_id`, `status`, `started_at`, and a composite `(pipeline_id, status, started_at)` |
| `channels` | one row per channel/synthesis result; `parsed_output` TEXT | `run_id`, `status` |
| `validation_errors` | one row per channel validation error | `run_id` |
| `usage` | one row per channel with `input_tokens`, `output_tokens`, `cost_usd` | `run_id` |
| `raw_outputs` | raw provider text as TEXT, keyed by `(run_id, ref)` | primary key |

Migration is idempotent (`CREATE TABLE IF NOT EXISTS …`) and runs on every
construction, so opening an existing database is safe.

### Filtered listing

Beyond the base `listRuns()` (which returns all run ids), the SQLite store adds
`listRunsFiltered({ pipelineId?, status?, startedAfter?, startedBefore? })`.
Filters are AND-combined; time-range filters compare against the run's
`startedAt` ISO-8601 timestamp.

Use the SQLite store when:

- You want to query run history by pipeline, status, or time range.
- You want a single portable file instead of a directory tree.
- You are embedding the kernel and prefer an in-process queryable store.

### CLI usage

```sh
# Default filesystem store at .runs/
llm-pipe run swot_recursive input.md

# SQLite store at the default path .runs/runs.sqlite
llm-pipe --store sqlite run swot_recursive input.md

# SQLite store at an explicit path
llm-pipe --store sqlite:/var/data/calane.sqlite run swot_recursive input.md

# Any other --store value is treated as a filesystem store root
llm-pipe --store ./my-runs run swot_recursive input.md
```

The exported run bundle is independent of the store backend: a run executed
through the SQLite store exports to a bundle identical (modulo `runId` and
timestamps) to one executed through the filesystem store.
