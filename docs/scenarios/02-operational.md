# Scenario 02 — Resume, diff, replay, cross-run stats

**Goal:** the day-two operations on stored runs — recover a partial run, compare
two runs, reproduce a bundle, and look at cost/latency/failure trends.

**Surfaces:** [CLI](../cli-reference.md). **Provider:** mock, except where marked
*illustrative*.

## Diff two runs

Run the same pipeline on two inputs, then diff them:

```bash
node packages/cli/dist/index.js run swot_recursive ./topic-a.md \
  --providers mock --depth 1 --export run_bundles   # note runId A
node packages/cli/dist/index.js run swot_recursive ./topic-b.md \
  --providers mock --depth 1 --export run_bundles   # note runId B
node packages/cli/dist/index.js diff <runId-A> <runId-B>
```

The diff is markdown by default (`--format json` for raw). Diffing two runs of
*different* pipeline definitions is refused with a `pipeline_mismatch` error —
the runs aren't comparable. See [diff.md](../diff.md).

## Replay a bundle

Re-execute an exported bundle and auto-diff the replay against the original.
Because the mock provider is deterministic, the replay is **identical**:

```bash
node packages/cli/dist/index.js replay run_bundles/<bundle-dir> --providers mock
```

Replay verifies the bundle's pipeline/prompt hashes first; a mismatch is refused
with a structured `ReplayError`. See [replay.md](../replay.md).

## Cross-run stats (SQLite store)

Aggregates need the SQLite store (the filesystem store is refused for
aggregation). Write a few runs to a SQLite store, then query it:

```bash
node packages/cli/dist/index.js --store sqlite run swot_recursive ./topic-a.md \
  --providers mock --depth 1 --export run_bundles
node packages/cli/dist/index.js --store sqlite run swot_recursive ./topic-b.md \
  --providers mock --depth 1 --export run_bundles

node packages/cli/dist/index.js --store sqlite stats cost
node packages/cli/dist/index.js --store sqlite stats latency
node packages/cli/dist/index.js --store sqlite stats failures --top 5
```

Add `--range 7d` to window, `--json` for machine-readable output. See
[stats.md](../stats.md).

## Resume a partial run *(illustrative)*

A run becomes `partial` when some channels error (e.g. a provider times out). The
mock provider never fails, so you can't produce a partial run offline — but when
you have one, resume carries completed channels forward and re-runs only the
failed ones:

```bash
# <runId> is a prior run with status: "partial"
node packages/cli/dist/index.js resume <runId> --export run_bundles
```

Resume refuses if the pipeline/prompt hashes changed since the prior run
(`hash_mismatch`) — you can't resume across a definition change. See
[resume.md](../resume.md).

---

**Verified by:** `packages/cli/tests/scenarios.test.ts` →
*"scenario 02: operational (diff, replay, stats)"*; resume is covered by
`packages/core/tests/resume.test.ts`.
