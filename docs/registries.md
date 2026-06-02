# Prompt registries

A prompt registry resolves pipeline definitions, prompt templates, and JSON
Schema files. Every registry conforms to `PromptRegistryInterface` from
`@llm-pipe/core` and returns a `ResolvedPipeline` carrying the spec, the
originating `registry` name, the `ref`, the `commitSha` (when applicable), and a
canonical `pipelineHash`.

## Filesystem registry (`@llm-pipe/registry-filesystem`)

Resolves from a directory tree:

```
<root>/pipelines/<id>.pipeline.yaml
<root>/prompts/...
<root>/schemas/...
```

`ref` is the pipeline file path; `commitSha` is `null`.

## Git registry (`@llm-pipe/registry-git`)

Resolves a pipeline definition from a Git repository at a specified ref, caches a
local clone, and records the resolved commit SHA in the `RunResult` (via
`source.commitSha`). Built on `simple-git` (a subprocess wrapper), so it inherits
the host's Git configuration — auth, SSH keys, credential helpers. (If the kernel
must run where Git is not installed, switching to `isomorphic-git` would require
a deviation.)

### URI scheme

```
git+<clone-url>#<ref>:<rootPath>
```

- **clone-url** — any URL `git clone` accepts (`https://…`, `file://…`, `ssh://…`).
  The leading `git+` is stripped before cloning.
- **ref** — a branch, tag, or commit SHA. Optional; defaults to `HEAD`.
- **rootPath** — the registry root directory inside the repo (the directory
  containing `pipelines/`, `prompts/`, `schemas/`). Optional; defaults to `.`.

Examples:

```
git+https://github.com/acme/analyses.git#main:.
git+https://github.com/acme/analyses.git#v1.2.0:swot
git+https://github.com/acme/analyses.git#9f8c2a1:pipelines/prod
```

### Caching and fetch

- The local clone is cached at `~/.calane/git-cache/<repo-hash>/`, where
  `<repo-hash>` is a stable hash of the clone URL. The cache root is overridable
  via the `cacheRoot` constructor option.
- Fetch is **lazy**: the repo is cloned on first use. When the requested ref is
  not resolvable locally, the registry fetches from origin before checking it out
  (cache invalidation on ref change). A checked-out branch is fast-forwarded to
  its remote tip when an upstream exists; detached refs (tags, SHAs) are left as
  pinned.

### Provenance

`resolvePipeline` returns `ResolvedPipeline.ref` set to the requested ref and
`commitSha` set to the resolved `HEAD` SHA after checkout, which the executor
records in `RunResult.source.ref` and `RunResult.source.commitSha`.

### Read-only

The Git registry only reads pipeline definitions. It never pushes or writes back
to the remote, and authentication is limited to whatever the host Git config and
`GIT_*` environment provide.

### Usage

```ts
import { GitPromptRegistry } from "@llm-pipe/registry-git";

const registry = new GitPromptRegistry(
  "git+https://github.com/acme/analyses.git#main:.",
);
const resolved = await registry.resolvePipeline("swot_recursive");
// resolved.commitSha is the resolved HEAD SHA at "main"
```

### CLI

Pass a `git+` URI to `--registry` and the CLI resolves pipelines from the Git
repo (recording the commit SHA in each run):

```bash
node packages/cli/dist/index.js \
  --registry "git+https://github.com/acme/analyses.git#main:." \
  run swot_recursive ./input.md --providers mock --export run_bundles
```

A plain directory path still selects the filesystem registry; the choice is made
by the `git+` prefix.

## External registry protocol (`ExternalRegistry`, S24)

Lets a pipeline be referenced by a canonical name across instances and resolved
**read-only** over HTTPS. This is **not a marketplace**: there is no publication
endpoint, no curation, no ratings, no discovery directory — resolution only.

### Reference scheme

```
<host>/<namespace>/<pipeline-id>@<version>
```

Resolution fetches:

```
GET https://<host>/pipelines/<namespace>/<pipeline-id>?version=<version>
```

A Calane instance serves the spec half of this protocol at
`GET /pipelines/<namespace>/<id>` (read-only spec resolution; the namespace is a
logical grouping and the local pipeline id must match `<id>`).

### Trust

Resolution is gated by an **explicit trusted-host allowlist**. An unlisted host
is refused with `untrusted_host`. The CLI reads the allowlist from
`CALANE_TRUSTED_HOSTS` (comma-separated hosts).

### Caching + hash verification

Resolved specs are cached on disk (`<store>/external-cache/`). Each cache entry
stores the spec text and its SHA-256; on every read the hash is re-verified, so a
tampered cache entry is rejected (`cache_corrupt`) rather than silently trusted.
A cache hit avoids re-fetching.

### Provenance

`resolvePipeline` returns `registry: "external"` and `ref` set to the full
canonical reference, which the executor records in `RunResult.source.registry`
(`"external"`) and `RunResult.source.ref`.

### CLI

```bash
export CALANE_TRUSTED_HOSTS=registry.example.org
llm-pipe run registry.example.org/acme/swot@v1.0.0 --input ./input.md
```

`ExternalRegistry` delegates prompt/schema loading and local (non-external)
pipeline resolution to a base registry, so a plain `llm-pipe run <id>` is
unchanged.
