# Delegated agents and callback signing

A channel may run in `delegated_agent` mode: instead of the kernel calling a
provider directly, it hands an instruction bundle to an external agent (LLM, tool
surface, MCP client) which does the work and returns a structured result through
a callback. Because that callback arrives over the network, it must be verifiable
as authentic against the run that dispatched it. Calane signs delegated-agent
callbacks with HMAC-SHA256.

## Per-channel signing secret

When a `delegated_agent` channel is dispatched, the kernel mints a fresh,
per-channel signing secret and persists it via the `CallbackSecretStore`,
**alongside the run but outside the bundle export**. The filesystem store writes
it to `<storeRoot>/callback-secrets/<runId>/callback-secrets.json`; the
`RunBundleExporter` only reads `run.json` and raw outputs, so the secret never
appears in an exported bundle and is never written to `RunResult`.

The secret is handed to the delegated agent as part of its dispatch so it can
sign its callback. It is not logged.

## Callback payload and signature

The signed payload contains exactly:

```json
{
  "runId": "run_…",
  "channelId": "…",
  "nonce": "…",
  "timestamp": "2026-05-25T10:00:00.000Z",
  "result": { "...": "the structured output" }
}
```

The signature is `HMAC-SHA256(secret, canonical(payload))` in hex, where
`canonical` is sorted-key JSON over exactly those five fields. The agent presents
it either in the `X-Callback-Signature` header or as a `signature` field in the
request body.

## Verification (REST)

```
POST /runs/:runId/channels/:channelId/callback
```

The endpoint:

1. Looks up the per-channel secret. If none exists, returns **401**.
2. Requires `nonce`, `timestamp`, and `result` (else **400**).
3. Verifies the HMAC in constant time. A missing or wrong signature returns
   **401** (`missing` / `invalid`).
4. Rejects callbacks whose `timestamp` is outside the replay window
   (default **1 hour**, configurable via `LLM_PIPE_CALLBACK_WINDOW_MS`) — **401**
   (`expired`).
5. Atomically consumes the `(runId, channelId, nonce)` tuple. A second
   presentation of the same nonce is a replay — **401** (`replayed`).

A valid callback returns **200** `{ accepted: true }`.

## MCP and the 8-tool ceiling

The MCP surface stays at exactly the 8 mandatory tools — **no callback tool is
added**. The signing/verification primitives (`signCallback`, `verifyCallback`,
`CallbackSecretStore`) live in `@llm-pipe/core` and back the REST callback
endpoint; an MCP host can reuse them to reject an invalid callback via an MCP
error without expanding the tool surface.

## Out of scope (this phase)

Provider-side signing (providers are not delegated agents), key rotation, and
per-instance signing keys are deferred (Phase 3 auth work).
