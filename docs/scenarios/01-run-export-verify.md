# Scenario 01 — Run → store → export → sign → verify

**Goal:** produce the kernel's core artifact — a traceable, versioned,
schema-validated reasoning run — and hand someone a bundle they can
cryptographically verify.

**Surfaces:** [CLI](../cli-reference.md). **Provider:** mock (runnable offline).

## Steps

### 1. Run a pipeline and persist it

`run` only persists the run when you pass `--export`, which also writes a bundle:

```bash
node packages/cli/dist/index.js run swot_recursive \
  examples/inputs/sample-topic.md \
  --providers mock --depth 1 --export run_bundles
```

The full `RunResult` is printed to stdout; note its `runId`. It carries
`source.pipelineHash`, `source.promptHashes`, and `source.schemaHashes` — the
provenance that makes the run reproducible.

### 2. Inspect the stored run

```bash
node packages/cli/dist/index.js get-run <runId>
```

### 3. Re-export with a detached signature

```bash
node packages/cli/dist/index.js export-run <runId> --out run_bundles --sign
```

`--sign` attaches an Ed25519 `signature.json` and a `canonical_ref.txt`
(`calane://run/<hash>`). The private key never enters the bundle. See
[run-bundle.md](../run-bundle.md) and
[canonical-references.md](../canonical-references.md).

### 4. Publish your public key

```bash
node packages/cli/dist/index.js export-key
```

Share this PEM so recipients can verify your signature.

### 5. Verify the bundle

```bash
node packages/cli/dist/index.js verify-bundle run_bundles/<bundle-dir>
# or pin a specific allowlisted key:
node packages/cli/dist/index.js verify-bundle run_bundles/<bundle-dir> \
  --public-key ./their-key.pem
```

A `valid: true` verdict means the bundle's content hash matches the signature and
nothing was tampered with after signing. Tampering with any file (e.g. editing
`final.md`) flips the verdict to `valid: false`.

## What you've proved

The recipient can recompute the schema/prompt hashes, confirm the signature, and
even [replay](./02-operational.md) the run — all without trusting you.

---

**Verified by:** `packages/cli/tests/scenarios.test.ts` →
*"scenario 01: run → store → export → sign → verify"* (and
`packages/cli/tests/phase6-bundle-signature.test.ts`).
