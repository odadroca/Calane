import { describe, expect, it } from "vitest";
import { buildExecutionPlan } from "../src/executor/ExecutionPlan.js";
import { PromptRenderer } from "../src/rendering/PromptRenderer.js";
import { parsePipeline, validatePipelineObject } from "../src/specs/loadPipeline.js";
import { canonicalJson, sha256 } from "../src/util/hash.js";
import { JsonSchemaValidator } from "../src/validation/JsonSchemaValidator.js";

describe("PromptRenderer", () => {
  it("substitutes the supported variables and leaves unknowns intact", () => {
    const out = new PromptRenderer().render(
      "in={{input}} d={{recursion_depth}} r={{run_id}} keep={{unknown}}",
      { input: "topic", recursionDepth: 2, runId: "run_x" },
    );
    expect(out).toBe("in=topic d=2 r=run_x keep={{unknown}}");
  });

  it("expands per-upstream-channel variables and leaves the bare token intact (S14)", () => {
    const out = new PromptRenderer().render(
      "p={{channel_results.dissent.parsed}} r={{channel_results.dissent.raw}} miss={{channel_results.nope.parsed}}",
      { input: "t", upstream: { dissent: { parsed: '{"a":1}', raw: "RAWTEXT" } } },
    );
    expect(out).toBe('p={"a":1} r=RAWTEXT miss={{channel_results.nope.parsed}}');
  });
});

describe("JsonSchemaValidator", () => {
  const schema = {
    type: "object",
    required: ["a"],
    properties: { a: { type: "number" } },
    additionalProperties: false,
  };
  const v = new JsonSchemaValidator();

  it("accepts valid JSON", () => {
    expect(v.parseAndValidate('{"a":1}', schema).outcome).toBe("valid");
  });
  it("flags invalid JSON", () => {
    expect(v.parseAndValidate("not json", schema).outcome).toBe("invalid_json");
  });
  it("flags schema errors", () => {
    expect(v.parseAndValidate('{"a":"x"}', schema).outcome).toBe("schema_error");
  });
  it("extracts JSON from fenced blocks", () => {
    expect(v.parseAndValidate('```json\n{"a":3}\n```', schema).outcome).toBe("valid");
  });
  it("compiles the same schema content twice without duplicate-$id errors", () => {
    const s = { $id: "dup.schema.json", type: "object", properties: {} };
    expect(v.parseAndValidate("{}", { ...s }).outcome).toBe("valid");
    expect(v.parseAndValidate("{}", { ...s }).outcome).toBe("valid");
  });
});

describe("hash", () => {
  it("is stable regardless of key order", () => {
    expect(sha256(canonicalJson({ a: 1, b: 2 }))).toBe(sha256(canonicalJson({ b: 2, a: 1 })));
  });
});

describe("pipeline spec", () => {
  const yaml = `id: p
version: 0.1.0
providers:
  - id: mock
    type: mock
channels:
  - id: c1
    executionMode: direct_provider
    prompt: prompts/c1.md
`;
  it("parses + validates a pipeline", () => {
    expect(parsePipeline(yaml).id).toBe("p");
  });
  it("rejects invalid specs", () => {
    expect(validatePipelineObject({ id: "x" }).valid).toBe(false);
  });
  it("builds an explicit execution plan", () => {
    const plan = buildExecutionPlan(parsePipeline(yaml));
    expect(plan.channels).toHaveLength(1);
    expect(plan.channels[0]!.provider.type).toBe("mock");
  });

  it("accepts a synthesis variant and rejects an unknown one (S15)", () => {
    const base = {
      id: "p",
      version: "0.1.0",
      providers: [{ id: "mock", type: "mock" }],
      channels: [{ id: "c1", executionMode: "direct_provider", prompt: "prompts/c1.md" }],
    };
    const good = {
      ...base,
      synthesis: {
        id: "synthesis",
        variant: "weighted",
        executionMode: "direct_provider",
        prompt: "prompts/synth.md",
      },
    };
    expect(validatePipelineObject(good).valid).toBe(true);
    const bad = {
      ...good,
      synthesis: { ...good.synthesis, variant: "not_a_variant" },
    };
    expect(validatePipelineObject(bad).valid).toBe(false);
  });
});
