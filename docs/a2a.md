# A2A AgentCard exposure (Phase 7 / R5)

Calane exposes each declared pipeline to **Agent2Agent (A2A)** clients: an
AgentCard manifest served at a `.well-known` path, plus a JSON-RPC invocation
endpoint that maps an A2A `message/send` request to **exactly one**
`run_pipeline` and returns a single **completed** A2A Task carrying the run's
synthesis as an artifact.

This rides on the public HTTPS host from R4 (Render deploy). It adds **no** new
MCP/openai tool — the 8-tool surface stays frozen. R5 is REST + `.well-known`
endpoints only.

## Vendored schema (the contract)

Everything Calane emits here (AgentCard, Task/Message/Artifact responses)
conforms to, and is validated against, the **vendored** A2A schema bundle:

- File: [`vendor/a2a/a2a.schema.json`](../vendor/a2a/a2a.schema.json)
- Provenance: [`vendor/a2a/PROVENANCE.md`](../vendor/a2a/PROVENANCE.md)

**This is a pinned, dated snapshot.** It was supplied by the operator and
vendored on 2026-05-26. The bundle carries `title: "A2A Protocol Schemas"`,
`$schema: JSON Schema 2020-12`, and a top-level `version: "v1"` — but **no
semver release tag**. Calane therefore treats it as a snapshot, echoes the
`"v1"` string as its advertised `protocolVersion`, and does **not** claim
conformance to any specific tagged A2A release. If a specific A2A protocol
version must be advertised, the operator must confirm it and re-vendor.

The bundle's `definitions` map uses **spaced display-name keys** (e.g.
`"Agent Card"`, `"Send Message Response"`) and cross-references definitions via
external-file-style `$ref`s (e.g. `lf.a2a.v1.AgentCapabilities.jsonschema.json`),
not `#/definitions/...`. Calane does **not** rewrite the vendored file. The
`A2AValidator` (in `@llm-pipe/core`, `packages/core/src/a2a/A2AValidator.ts`)
registers each definition with Ajv's **2020-12** dialect (`ajv/dist/2020` — Ajv
is already a dependency; no new package, no Zod) under an `$id` equal to the
filename it is referenced by, so those `$ref`s resolve. Validation is addressed
by the spaced definition name.

## Synchronous, non-streaming mapping (honest capabilities)

Calane is an **explicit-loop, single-shot `run_pipeline` kernel** — not an
agent-managed task lifecycle. The AgentCard declares this honestly and advertises
**no** capability the kernel does not actually honor:

- `capabilities.streaming: false`
- `capabilities.pushNotifications: false`
- `capabilities.extendedAgentCard: false`

A pipeline invocation is represented as **one completed Task**, not a
long-running agent-driven lifecycle:

- One `message/send` JSON-RPC call -> exactly one `run_pipeline` -> one Task with
  `status.state = TASK_STATE_COMPLETED` (or `TASK_STATE_FAILED` for a
  failed/partial run).
- The run's synthesis is returned as the Task's single artifact
  (`artifacts[0]`): a `data` part (`application/json`) for structured synthesis
  output, or a `text` part (`text/plain`) otherwise.
- Streaming / push-notification / subscribe methods are rejected
  (`-32601 Unsupported method`).

## Endpoints

### Discovery (public)

- `GET /.well-known/agent-card.json` — **index card**. Calane hosts many
  pipelines, so the well-known card lists each pipeline as a skill and points
  (`supportedInterfaces`) at the per-pipeline AgentCards. Served at the current
  A2A well-known convention path (`agent-card.json`, the post-rename name).
- `GET /.well-known/agent-card/<pipelineId>` — the **per-pipeline AgentCard**,
  the invocable agent. Returns 404 for an unknown pipeline.

Both discovery routes are **public** (no token) so a client can fetch a card
before authenticating. This is a deliberate choice documented here.

### Invocation (auth-gated)

- `POST /a2a/<pipelineId>` — JSON-RPC 2.0 `message/send`. Requires a valid bearer
  / OAuth token whenever auth is enforced (same S11 bearer / R2 OIDC dual auth as
  the rest of the REST surface). Returns the JSON-RPC envelope
  `{ jsonrpc, id, result: { task } }`, where `result` is an A2A **Send Message
  Response** carrying the completed Task.

Example request body:

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/send",
  "params": {
    "message": {
      "role": "ROLE_USER",
      "messageId": "m1",
      "parts": [{ "text": "Analyze ACME Corp" }]
    }
  }
}
```

The input string handed to `run_pipeline` is the concatenation of the message's
text parts (data parts are JSON-stringified).

## AgentCard field mapping (PipelineSpec -> Agent Card)

| Agent Card field | Source |
|---|---|
| `name` | `PipelineSpec.name ?? id` |
| `description` | `PipelineSpec.description` (honest default otherwise) |
| `version` | `PipelineSpec.version` (the pipeline version doubles as agent version) |
| `provider.organization` / `provider.url` | `"Calane (llm-pipeline-kernel)"` / public base URL |
| `capabilities` | honest fixed values (see above) |
| `defaultInputModes` | `["text/plain"]` |
| `defaultOutputModes` | `["application/json"]` when a synthesis channel exists, else `["text/plain"]` |
| `skills[0]` | one skill = the pipeline (`id`, `name`, `description`, `tags` = provider types, input/output modes) |
| `supportedInterfaces[0]` | the JSON-RPC invocation URL (`/a2a/<id>`), `protocolBinding: "JSONRPC"`, `protocolVersion: "v1"` |
| `securitySchemes` / `securityRequirements` | bearer auth, declared **only** when the kernel enforces auth (honest) |

Fields present in the PipelineSpec map straight in; A2A-required fields Calane
lacks get sensible honest defaults. No field outside the vendored schema is
invented — the conformance tests (`packages/server/tests/a2a.test.ts`) assert
that the emitted AgentCard and Task/Message responses validate against the
vendored bundle.

## What is NOT implemented (out of scope / non-goals)

- No streaming, push notifications, or long-running agent-managed task lifecycle.
- No new MCP/openai tool (8-tool surface frozen).
- Calane is not turned into a general-purpose agent framework — it exposes
  existing pipelines to A2A callers, nothing more.
