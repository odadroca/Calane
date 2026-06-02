# End-to-end scenarios

Practical, copy-pasteable walkthroughs that pair the per-surface reference docs
([CLI](../cli-reference.md), [REST](../rest-reference.md), [MCP](../mcp.md)) with
real use-cases. Read the references for *what every command does*; read these for
*how to string them together to get something done*.

## Conventions

- **Runnable** blocks execute offline against the deterministic **mock**
  provider, using the pipelines under [`examples/`](../../examples). You can paste
  them verbatim after `pnpm install && pnpm build`.
- **Illustrative** blocks (clearly marked) need a real provider, network egress,
  or a second instance, so they can't be reproduced offline. The *mechanism* they
  show is still covered by a test (cited under "Verified by").
- Every scenario lists a **Verified by** footer pointing at the test(s) that
  exercise the same flow, so these walkthroughs can't silently rot. The
  scenario-specific tests live at:
  - `packages/cli/tests/scenarios.test.ts`
  - `packages/server/tests/scenario-rest.test.ts`
  - `packages/mcp-server/tests/scenario-mcp.test.ts`

Run them with `pnpm test` (or, just the scenarios:
`npx vitest run packages/cli/tests/scenarios.test.ts`).

## Why the mock provider

The mock provider is deterministic and schema-synthesizing, so a documented run
produces the same structured output every time. That is what makes these
scenarios *reproducible* and lets a replay or a signed-bundle verification be a
hard assertion rather than a guess.

## The scenarios

| # | Scenario | Surfaces |
| --- | --- | --- |
| [01](./01-run-export-verify.md) | Run → store → export → sign → verify | CLI |
| [02](./02-operational.md) | Resume, diff, replay, cross-run stats | CLI |
| [03](./03-surfaces.md) | Drive a pipeline via REST, MCP, and A2A | REST / MCP / A2A |
| [04](./04-multi-model-and-federation.md) | Rank providers; fetch a run from a peer | CLI / federation |
| [05](./05-connect-a-registry.md) | Connect an external / GitHub prompt registry | CLI / API |

New to the kernel? Start with [01](./01-run-export-verify.md) — it's the "hello
world" end-to-end loop the rest build on.
