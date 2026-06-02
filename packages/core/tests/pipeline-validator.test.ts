import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { PipelineValidator } from "../src/validation/PipelineValidator.js";

const root = fileURLToPath(new URL("./fixtures/validate", import.meta.url));
const registered = new Set(["mock", "openai-compatible", "delegated-agent"]);

function makeValidator() {
  return new PipelineValidator({
    loadPrompt: (p) => readFile(join(root, p), "utf8"),
    loadSchema: async (p) => JSON.parse(await readFile(join(root, p), "utf8")),
    hasProvider: (t) => registered.has(t),
  });
}

async function loadSpec(name: string): Promise<unknown> {
  return parseYaml(await readFile(resolve(root, "pipelines", name), "utf8"));
}

describe("PipelineValidator", () => {
  it("accepts a valid pipeline", async () => {
    const report = await makeValidator().validate(await loadSpec("valid.pipeline.yaml"));
    expect(report.valid).toBe(true);
    expect(report.pipelineId).toBe("valid_pipeline");
    expect(report.issues).toHaveLength(0);
  });

  it("rejects a spec that violates the PipelineSpec schema", async () => {
    const report = await makeValidator().validate(await loadSpec("bad-spec.pipeline.yaml"));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.check === "spec_schema")).toBe(true);
  });

  it("rejects a pipeline referencing a missing prompt file", async () => {
    const report = await makeValidator().validate(await loadSpec("missing-prompt.pipeline.yaml"));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.check === "prompt_missing")).toBe(true);
  });

  it("rejects a pipeline referencing a missing schema file", async () => {
    const report = await makeValidator().validate(await loadSpec("missing-schema.pipeline.yaml"));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.check === "schema_missing")).toBe(true);
  });

  it("rejects a pipeline declaring an unregistered provider type", async () => {
    const report = await makeValidator().validate(await loadSpec("unknown-provider.pipeline.yaml"));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.check === "provider_missing")).toBe(true);
  });

  it("rejects a pipeline with a cyclic dependsOn graph (S14)", async () => {
    const report = await makeValidator().validate(await loadSpec("cyclic.pipeline.yaml"));
    expect(report.valid).toBe(false);
    const cycle = report.issues.find((i) => i.check === "cycle");
    expect(cycle).toBeDefined();
    expect(cycle?.message).toMatch(/cyclic/i);
  });

  it("rejects a pipeline depending on an unknown channel id (S14)", async () => {
    const report = await makeValidator().validate(await loadSpec("unknown-dep.pipeline.yaml"));
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.check === "cycle")).toBe(true);
  });

  it("accepts a valid branching DAG pipeline (S14)", async () => {
    const report = await makeValidator().validate(await loadSpec("dag.pipeline.yaml"));
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });
});
