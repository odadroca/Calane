import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JsonSchemaValidator } from "@llm-pipe/core";
import { describe, expect, it } from "vitest";
import {
  OPENAI_ENDPOINT_DESC_LIMIT,
  OPENAI_PARAM_DESC_LIMIT,
  OPENAPI_OPERATION_IDS,
  assertOpenAiLimits,
  buildOpenApiDocument,
} from "../src/openapi.js";
import { buildServer } from "../src/server.js";

/** The 8 frozen tools, expressed as the operationIds the GPT Action exposes. */
const EXPECTED_OPERATIONS = [
  "run_pipeline",
  "get_run_result",
  "list_pipelines",
  "validate_pipeline",
  "export_run_bundle",
  "rerun_channel",
  "list_runs",
  "get_pipeline_spec",
];

function operationIds(doc: Record<string, any>): string[] {
  const ids: string[] = [];
  for (const methods of Object.values(doc.paths as Record<string, Record<string, any>>)) {
    for (const op of Object.values(methods)) {
      if (op && typeof op === "object" && "operationId" in op) ids.push(op.operationId);
    }
  }
  return ids;
}

describe("OpenAPI 3.1 document (R3)", () => {
  it("is a valid OpenAPI 3.1 document with info and a server", () => {
    const doc = buildOpenApiDocument({ serverUrl: "https://example.test" });
    expect(doc.openapi).toBe("3.1.0");
    expect((doc.info as any).title).toBe("llm-pipeline-kernel");
    expect((doc.servers as any[])[0].url).toBe("https://example.test");
  });

  it("declares an HTTP bearer security scheme reusing S11", () => {
    const doc = buildOpenApiDocument();
    const scheme = (doc.components as any).securitySchemes.bearerAuth;
    expect(scheme).toEqual({ type: "http", scheme: "bearer" });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("exposes exactly the 8-tool operation set (1:1 with the frozen surface)", () => {
    const doc = buildOpenApiDocument();
    expect(operationIds(doc).sort()).toEqual([...EXPECTED_OPERATIONS].sort());
    expect([...OPENAPI_OPERATION_IDS].sort()).toEqual([...EXPECTED_OPERATIONS].sort());
  });

  it("respects OpenAI field-length limits (≤300 endpoint / ≤700 param)", () => {
    const doc = buildOpenApiDocument();
    // Does not throw.
    expect(() => assertOpenAiLimits(doc)).not.toThrow();
    // And actually checks: an over-limit description is rejected.
    const bad = buildOpenApiDocument();
    (bad.paths as any)["/runs"].post.description = "x".repeat(OPENAI_ENDPOINT_DESC_LIMIT + 1);
    expect(() => assertOpenAiLimits(bad)).toThrow(/exceeds/);
    const badParam = buildOpenApiDocument();
    (badParam.paths as any)["/runs/{runId}"].get.parameters[0].description = "y".repeat(
      OPENAI_PARAM_DESC_LIMIT + 1,
    );
    expect(() => assertOpenAiLimits(badParam)).toThrow(/parameter/);
  });

  it("derives request/response schemas from TypeBox (valid JSON Schema, Ajv-compilable)", () => {
    const doc = buildOpenApiDocument();
    const schemas = (doc.components as any).schemas;
    const validator = new JsonSchemaValidator();
    // If TypeBox emitted anything that is not valid JSON Schema, compile throws.
    expect(() => validator.compile(schemas.RunRequest)).not.toThrow();
    expect(() => validator.compile(schemas.RunResult)).not.toThrow();
    // RunRequest requires pipelineId + input (proves it is the TypeBox schema).
    expect(schemas.RunRequest.properties.pipelineId).toBeDefined();
    expect(schemas.RunRequest.properties.input).toBeDefined();
  });

  it("is served unauthenticated at GET /openapi.json even when auth is enabled", async () => {
    const { TokenAuth } = await import("../src/auth.js");
    const auth = new TokenAuth({ env: { CALANE_API_TOKEN: "secret" } as NodeJS.ProcessEnv });
    const app = buildServer({ logger: false, auth });
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(operationIds(body).sort()).toEqual([...EXPECTED_OPERATIONS].sort());
    await app.close();
  });

  it("matches the committed public/openapi.json operation set", () => {
    const path = fileURLToPath(new URL("../public/openapi.json", import.meta.url));
    const committed = JSON.parse(readFileSync(path, "utf8"));
    expect(committed.openapi).toBe("3.1.0");
    expect(operationIds(committed).sort()).toEqual([...EXPECTED_OPERATIONS].sort());
  });
});
