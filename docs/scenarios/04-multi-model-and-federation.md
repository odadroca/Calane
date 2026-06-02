# Scenario 04 — Rank providers; fetch a run from a peer

**Goal:** two multi-instance/multi-model use-cases — pick the best provider for a
pipeline, and pull a signed run from a trusted peer instance.

**Surfaces:** [CLI](../cli-reference.md), federation
([federation.md](../federation.md)).

## Rank providers with select-model

`select-model` runs each provider N times and ranks them by validation,
structural conformance, cost, and latency. Offline you can rank the mock
provider alone:

```bash
node packages/cli/dist/index.js select-model \
  --pipeline swot_recursive \
  --input examples/inputs/sample-topic.md \
  --providers mock --runs 3
```

The report's `recommendation` is the top-ranked provider id. See
[model-selection.md](../model-selection.md).

### Comparing real models *(illustrative)*

With provider keys configured you can compare several and tune the weights:

```bash
OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-... \
node packages/cli/dist/index.js select-model \
  --pipeline swot_recursive --input ./input.md \
  --providers mock,openai-compatible,anthropic \
  --runs 5 --weight-cost 0.5 --weight-validation 0.3
```

## Fetch a run from a peer *(illustrative)*

Federation lets one instance fetch a *signed* run from another, verify it against
an allowlisted key, and store it read-only. It needs a second instance and a
trust allowlist (`CALANE_TRUST_CONFIG`), so it isn't reproducible offline:

```bash
# On the source instance: publish your public key.
node packages/cli/dist/index.js export-key > source-instance.pem

# On the fetching instance: with the source allowlisted in CALANE_TRUST_CONFIG,
# fetch a run by its canonical reference.
export CALANE_TRUST_CONFIG=./trust.json
node packages/cli/dist/index.js fetch-run calane://run/<hash> \
  --instance source-instance-id
```

An untrusted instance is refused (`untrusted_instance`); a tampered run fails
signature verification. The REST equivalents are `GET /federated/bundles/:ref`
(serve) and `GET /federated/runs/:ref?instance=` (fetch). See
[federation.md](../federation.md) and [rest-reference.md](../rest-reference.md).

---

**Verified by:** select-model — `packages/cli/tests/scenarios.test.ts` →
*"scenario 04: rank providers with select-model"*; federation —
`packages/server/tests/federation.test.ts`.
