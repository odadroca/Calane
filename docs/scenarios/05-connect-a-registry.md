# Scenario 05 — Connect an external / GitHub prompt registry

**Goal:** run pipelines that live *outside* this repo — in a peer Calane instance
or in a Git host like GitHub — so a distributed Calane can share versioned
pipeline definitions.

**Surfaces:** [CLI](../cli-reference.md) and the registry API
([registries.md](../registries.md)).

There are two distinct mechanisms; pick by where the pipeline lives.

## A. External registry over HTTPS (Calane ↔ Calane)

A Calane instance serves the spec half of the external-registry protocol at
`GET /pipelines/<namespace>/<id>`. Another instance can reference it by canonical
name. Resolution is **read-only** and gated by a trusted-host allowlist (not a
marketplace — no publish/curate/rate).

```bash
export CALANE_TRUSTED_HOSTS=registry.example.org
node packages/cli/dist/index.js \
  run registry.example.org/acme/swot@v1.0.0 ./input.md --providers mock
```

The resolved spec is cached under `<store>/external-cache/` with its SHA-256
re-verified on every read (a tampered cache entry is rejected). The run records
`source.registry = "external"` and `source.ref` = the full reference. A plain
`run <id>` against the local registry is unchanged.

## B. Git registry (e.g. GitHub)

Keep `pipelines/`, `prompts/`, and `schemas/` in a Git repo and resolve a
pipeline at a branch, tag, or commit SHA — the resolved commit SHA is recorded in
the run for provenance. The URI scheme is:

```
git+<clone-url>#<ref>:<rootPath>
# e.g. git+https://github.com/acme/analyses.git#main:.
```

### B1. CLI (`--registry git+…`)

Pass a `git+` URI to `--registry` and the CLI resolves the pipeline from the
repo, recording the resolved commit SHA in the run:

```bash
node packages/cli/dist/index.js \
  --registry "git+https://github.com/acme/analyses.git#main:." \
  run swot_recursive ./input.md --providers mock --export run_bundles
node packages/cli/dist/index.js export-run <runId> --out run_bundles --sign
node packages/cli/dist/index.js verify-bundle run_bundles/<bundle-dir>
```

The repo is cloned/cached under `~/.calane/git-cache/` and re-fetched when the
requested ref changes. It's read-only and uses the host's Git auth (SSH keys,
credential helpers). A plain directory path still selects the filesystem
registry — the `git+` prefix makes the choice. See
[registries.md](../registries.md).

### B2. Programmatic (embed in your own code)

```ts
import {
  PipelineExecutor,
  ProviderRegistry,
  RunBundleExporter,
  InstanceKeypair,
  verifyBundleDir,
} from "@llm-pipe/core";
import { MockProvider } from "@llm-pipe/provider-mock";
import { GitPromptRegistry } from "@llm-pipe/registry-git";
import { FilesystemResultStore } from "@llm-pipe/store-filesystem";

const registry = new GitPromptRegistry(
  "git+https://github.com/acme/analyses.git#main:.",
);
const store = new FilesystemResultStore(".runs");
const providers = new ProviderRegistry().register(new MockProvider());
const executor = new PipelineExecutor({ registry, providers, store });

const run = await executor.run({
  pipelineId: "swot_recursive",
  input: "Evaluate releasing the kernel as open source.",
  options: { providers: ["mock"] },
});
// run.source.registry === "git"; run.source.commitSha === resolved HEAD SHA

const { bundlePath } = await new RunBundleExporter(store).export(run, {
  outDir: "run_bundles",
  keypair: new InstanceKeypair().ensure(),
});
console.log((await verifyBundleDir(bundlePath)).valid); // true
```

This is the same resolution as B1, exposed as a library — use it when you embed
the kernel in your own process rather than driving it from the CLI.

---

**Verified by:** `packages/cli/tests/scenarios.test.ts` →
*"scenario 05a: connect an external registry over HTTPS"* and
*"scenario 05b: connect a Git (e.g. GitHub) prompt registry"* (the test uses a
local `git+file://` fixture to stay offline); see also
`packages/cli/tests/phase6-external-registry.test.ts` and
`packages/registries/git/tests/git-registry.test.ts`.
