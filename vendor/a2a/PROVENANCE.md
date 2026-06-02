# Vendored A2A schema (snapshot)

`a2a.schema.json` is the Agent2Agent (A2A) protocol JSON Schema bundle, vendored
into this repo so the Phase 7 **R5** sprint (A2A AgentCard exposure) can be built
and validated **offline** — the build environment cannot reach the authoritative
A2A hosts (`a2a-protocol.org` is host-blocked; the upstream `a2a.json` is a
generated artifact not committed to the A2A repo).

## Provenance

- **Source:** supplied by the operator (uploaded), 2026-05-26.
- **Document:** `title: "A2A Protocol Schemas"`, `$schema: JSON Schema 2020-12`.
- **Contents:** 47 definitions, including `Agent Card`, `Message`, `Task`, the
  task / push-notification request+response types, and OAuth/API-key security
  schemes.
- **Version:** NOT embedded in the file. Treat this as a **pinned snapshot** of
  the A2A schema as of the upload date, not a version-tagged release. If a
  specific A2A protocol version must be advertised in an AgentCard, the operator
  must confirm it.

## Status / canonical source

This is a **non-normative snapshot**. Upstream, the A2A JSON Schema is generated
from the canonical protocol definition; this file is a convenience copy for
offline builds. If upstream A2A changes, re-vendor a fresh snapshot. Code in R5
should treat THIS file as the contract it conforms to and validates against, and
record that it did so (no guessing at fields outside this schema).

## Canonical proto (`a2a.proto`)

The operator also supplied the canonical protocol definition `a2a.proto`
(34,461 bytes, `syntax = proto3`, `package lf.a2a.v1`, `service A2AService`).
The JSON Schema bundle above is generated from this proto; the proto is the
source of truth for field semantics.

**Two distinct version fields (do not conflate):**
- `AgentInterface.protocol_version` — the **A2A protocol** version this interface
  exposes. Proto examples: `"0.3"`, `"1.0"`. Package namespace is `lf.a2a.v1`
  (protocol major **v1**).
- `AgentCard.version` (REQUIRED) — the **agent's own implementation** version.
  Proto example: `"1.0.0"` (this is just the field's example value, NOT the
  protocol version).

Capability mapping confirmed against the proto: `AgentCapabilities.streaming` and
`.push_notifications` are the booleans Calane sets to `false` (synchronous,
single completed Task); `SendMessageResponse` is a `oneof { Task, Message }`
returned synchronously from `rpc SendMessage` (HTTP binding `POST /message:send`).
