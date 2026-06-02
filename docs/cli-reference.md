# CLI reference (`llm-pipe`)

Complete reference for every `llm-pipe` command, its arguments, options, output,
and exit codes. The CLI is the local-first driver for the kernel; the same
operations are also reachable over [REST](./rest-reference.md) and
[MCP](./mcp.md).

## Invocation

After `pnpm build`, the CLI lives at `packages/cli/dist/index.js`:

```bash
node packages/cli/dist/index.js <command> [args] [options]
# convenience alias (forwards args):
pnpm cli <command> [args] [options]
```

All examples below use the explicit `node …` form. Output that is a result
object is printed as pretty JSON to **stdout**; human-oriented notes (e.g.
"Bundle exported to …") and structured errors go to **stderr**.

## Global options

These precede the subcommand and apply to every command.

| Option | Default | Description |
| --- | --- | --- |
| `--registry <dir-or-git-uri>` | `examples` (or `$LLM_PIPE_REGISTRY`) | Registry root holding `pipelines/`, prompts, and schemas — a local directory, **or** a `git+<url>#<ref>:<rootPath>` URI to resolve from a Git repo (e.g. GitHub), recording the commit SHA. See [registries.md](./registries.md). |
| `--store <target>` | `.runs` filesystem (or `$LLM_PIPE_STORE`) | Result store: a **directory path** (filesystem) or `sqlite[:<path>]` to use the SQLite store (defaults to `.runs/runs.sqlite`). |

The SQLite store is required for the `stats` subcommands (filesystem is too slow
for cross-run aggregation — see below).

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `LLM_PIPE_REGISTRY` | all | Default registry root when `--registry` is omitted. |
| `LLM_PIPE_STORE` | all | Default store root when `--store` is omitted. |
| `CALANE_KEYS_DIR` | `export-run --sign`, `verify-bundle`, `export-key` | Directory for the instance Ed25519 keypair. |
| `CALANE_TRUSTED_HOSTS` | `run` (external refs) | Comma-separated allowlist of hosts for resolving external pipeline references. |
| `CALANE_FEDERATION_TOKEN` | `run` (external refs), `fetch-run` | Bearer token presented when fetching from remote instances. |
| `CALANE_TRUST_CONFIG` | `fetch-run` | Path to a JSON federation trust allowlist (instance id/url → public key). |
| `OPENAI_API_KEY` / provider `apiKeyEnv` | `run` with `openai-compatible` | API key for an OpenAI-style provider. |
| `ANTHROPIC_API_KEY` | `run` with `anthropic` | API key for the Anthropic provider. |

---

## `run` — execute a pipeline

```
llm-pipe run <pipeline> <input-file> [options]
```

Runs a pipeline against the contents of an input file and prints the full
`RunResult` JSON. The run is persisted to the store only when `--export` is used
(export attaches the bundle path and saves the run); a plain `run` prints the
result without persisting.

**Arguments**

- `<pipeline>` — a local pipeline id, **or** an external reference
  `<host>/<namespace>/<id>@<version>` (resolved over HTTPS against
  `CALANE_TRUSTED_HOSTS`; see [federation.md](./federation.md) and
  [registries.md](./registries.md)).
- `<input-file>` — path to a markdown/text file used as the pipeline input.

**Options**

| Option | Default | Description |
| --- | --- | --- |
| `--providers <list>` | `mock` | Comma-separated provider ids (e.g. `mock`, `openai-compatible`, `anthropic`). |
| `--depth <n>` | pipeline default | Recursion max-depth override (recursion is bounded and explicit — never model-decided). |
| `--concurrency <n>` | pipeline default | Max concurrent channels (see [concurrency.md](./concurrency.md)). |
| `--export [dir]` | — | After the run, export a bundle to `dir` (default `run_bundles`) and persist the run. |

**Examples**

```bash
# Offline SWOT run with the mock provider, bounded recursion, export a bundle
node packages/cli/dist/index.js run swot_recursive \
  examples/inputs/sample-topic.md --providers mock --depth 1 --export run_bundles

# Run against a real OpenAI-compatible endpoint
OPENAI_API_KEY=sk-... node packages/cli/dist/index.js \
  run swot_recursive ./input.md --providers openai-compatible
```

**Exit codes** — `0` on success; `1` if an external reference fails to resolve
(`ExternalRegistryError`, printed as `{ error, code }`). Other errors throw.

---

## `resume` — resume a partial run

```
llm-pipe resume <run-id> [--export [dir]]
```

Resumes a prior partial run from its last-good channel; already-completed
channels are carried forward (pipeline id and input come from the prior run).
See [resume.md](./resume.md).

- `<run-id>` — the prior run to resume.
- `--export [dir]` — export + persist a bundle after the resumed run.

**Exit codes** — `1` with a structured `ResumeError` (e.g. run not found, or the
run is not resumable); else `0`.

---

## `list-pipelines` — list available pipelines

```
llm-pipe list-pipelines
```

Prints a JSON array of pipeline ids from the active registry.

---

## `get-run` — fetch a stored run

```
llm-pipe get-run <run-id>
```

Prints the stored `RunResult` JSON. Exits `1` with `Run not found: <id>` on
stderr if the id is unknown.

---

## `export-run` — export a stored run as a bundle

```
llm-pipe export-run <run-id> [options]
```

Re-exports a previously stored run as a [run bundle](./run-bundle.md).

| Option | Default | Description |
| --- | --- | --- |
| `--out <dir>` | `run_bundles` | Output directory for the bundle. |
| `--redacted` | off | Redact obvious secrets from raw outputs. |
| `--sign` | off | Attach a detached Ed25519 signature + canonical reference (see [canonical-references.md](./canonical-references.md)). |

Prints the exporter result JSON (`{ bundlePath, … }`). Exits `1` if the run is
not found.

---

## `validate-pipeline` — structurally validate a definition file

```
llm-pipe validate-pipeline <path>
```

Validates a `.pipeline.yaml`/`.json` **file on disk** (not a stored id) against
the spec schema, resolving its prompts/schemas/providers. The registry root is
inferred: an explicit `--registry` wins; otherwise the parent of a `pipelines/`
folder, else the file's own directory. See [pipeline-validate.md](./pipeline-validate.md).

Prints a validation report `{ valid, pipelineId, issues[] }`. Exits `1` when
`valid` is `false` (including unreadable/unparseable files).

---

## `stats` — cross-run aggregate queries (SQLite only)

```
llm-pipe --store sqlite stats <cost|latency|failures> [options]
```

Aggregates across **all** stored runs. Requires the SQLite store; with any other
store these emit the structured `stats_requires_sqlite` error to stderr and exit
`1`. See [stats.md](./stats.md). Each subcommand prints an ASCII table by default
or raw JSON with `--json`.

A `--range` window accepts a relative form (`7d`, `24h`) or an ISO date used as
an inclusive lower bound.

### `stats cost`

```
llm-pipe --store sqlite stats cost [--pipeline <id>] [--range <window>] [--json]
```

Cost over time, bucketed by day. `--pipeline` filters to one pipeline.

### `stats latency`

```
llm-pipe --store sqlite stats latency [--provider <id>] [--range <window>] [--json]
```

Latency by provider. `--provider` filters to one provider.

### `stats failures`

```
llm-pipe --store sqlite stats failures [--range <window>] [--top <n>] [--json]
```

Validation failure rate by pipeline plus the top failed channels. `--top <n>`
caps the number of top channels.

---

## `diff` — compare two stored runs

```
llm-pipe diff <run-id-a> <run-id-b> [--format markdown|json]
```

Structural + content diff of two runs of the **same** pipeline definition.
Defaults to markdown; `--format json` emits the raw diff. See [diff.md](./diff.md).

**Exit codes** — `1` if either run is missing, or `1` on a refuse-to-diff
`pipeline_mismatch` (the two runs have different `pipelineHash`).

---

## `select-model` — rank providers for a pipeline

```
llm-pipe select-model --pipeline <id> --input <file> --providers <list> [options]
```

Runs each provider N times and ranks them by validation, structural conformance,
cost, and latency. See [model-selection.md](./model-selection.md).

| Option | Default | Description |
| --- | --- | --- |
| `--pipeline <id>` | required | Pipeline to evaluate. |
| `--input <file>` | required | Input file. |
| `--providers <list>` | required | Comma-separated providers to compare. |
| `--runs <n>` | `3` | Runs per provider. |
| `--weight-validation <n>` | — | Weight for the validation factor. |
| `--weight-conformance <n>` | — | Weight for structural conformance. |
| `--weight-cost <n>` | — | Weight for cost. |
| `--weight-latency <n>` | — | Weight for latency. |
| `--json` | off | Emit raw JSON instead of the ranking table. |

---

## `replay` — replay a run from an exported bundle

```
llm-pipe replay <bundle-path> [--providers <list>] [--format markdown|json]
```

Verifies the bundle's hashes, re-executes it, and diffs the replay against the
original. Prints `Replayed <orig> -> <new>` on stderr and the diff on stdout. See
[replay.md](./replay.md).

| Option | Default | Description |
| --- | --- | --- |
| `--providers <list>` | bundle's | Providers to use for the replay. |
| `--format <fmt>` | `markdown` | `markdown` or `json` diff output. |

**Exit codes** — `1` with a structured `ReplayError` (e.g. hash mismatch); else `0`.

---

## `verify-bundle` — verify a signed bundle

```
llm-pipe verify-bundle <bundle-path> [--public-key <pem-file>]
```

Verifies a bundle's detached Ed25519 signature and content hash. With
`--public-key`, verifies against a specific (allowlisted) public-key PEM. Prints
the verdict JSON; exits `1` when `valid` is `false`. See
[canonical-references.md](./canonical-references.md).

---

## `export-key` — print this instance's public key

```
llm-pipe export-key
```

Prints this instance's Ed25519 **public** key PEM to stdout, generating the
keypair on first use (under `CALANE_KEYS_DIR`). Share this key so others can
verify bundles you sign.

---

## `fetch-run` — fetch a signed run from a trusted remote

```
llm-pipe fetch-run <canonical-ref> --instance <id-or-url>
```

Fetches a signed run from an allowlisted remote instance, verifies its signature
against the trusted key, and stores it read-only. See [federation.md](./federation.md).

- `<canonical-ref>` — a `calane://run/<hash>` reference.
- `--instance <id-or-url>` — required; an allowlisted remote instance id or base
  URL (allowlist from `CALANE_TRUST_CONFIG`).

**Exit codes** — `1` with a structured `FederationError` (e.g. untrusted
instance, fetch failure); else `0`.
</content>
</invoke>
