# Schema authoring rule

**TypeBox is the single source of truth for all schemas. Zod is forbidden.**

## How it works

- **Internal contracts** (`PipelineSpec`, `ChannelSpec`, `ProviderSpec`,
  `RunRequest`, `RunResult`, `ChannelResult`, …) are authored once in TypeBox
  under `packages/core/src/specs/`. The TypeScript types are derived with
  `Static<typeof X>` — no hand-written duplicate types.
- **TypeBox produces JSON Schema by construction.** The same TypeBox objects are
  used for runtime validation and can be emitted as JSON Schema for descriptors.
- **Ajv compiles and validates.** `JsonSchemaValidator` (Ajv + ajv-formats)
  validates both TypeBox-produced schemas and **external JSON Schema files on
  disk** authored by users (e.g. `examples/schemas/*.json`).
- **Pipeline parsing** (`parsePipeline`) validates YAML/JSON against the TypeBox
  `PipelineSpec` using `@sinclair/typebox/value`.
- **MCP tool descriptors** and **openai.json action specs** are plain JSON
  Schema objects — the same schema language TypeBox emits — never Zod.
- **LLM structured-output schemas** are JSON Schema files on disk, referenced by
  `ChannelSpec.outputSchema`, validated by the same Ajv instance.

## Hashing

`schemaHashes` and `promptHashes` in `RunResult.source` are computed with
`node:crypto` (`packages/core/src/util/hash.ts`):

- prompt hashes: sha256 of the prompt **template text**.
- schema hashes: sha256 of the **canonical JSON** of the schema (keys sorted),
  so semantically identical schemas hash identically regardless of key order.
- pipeline hash: sha256 of the canonical JSON of the resolved spec.

## The rule, restated

> Do not introduce a second schema system. Internal Zod usage is forbidden in
> this codebase.

This is enforced socially (review + this doc) and is easy to check:

```bash
grep -rni "zod" packages --include="*.ts"   # should match only rule-reference comments
```
