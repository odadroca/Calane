/**
 * OpenAPI 3.1 document for the Custom GPT Action (R3).
 *
 * This is the machine-readable REST contract a single Custom GPT (or any
 * OpenAPI-style caller) imports as an Action. It is DERIVED from the TypeBox
 * single-source schemas (`RunRequest`, `RunResult`, ...) re-exported by
 * `@llm-pipe/core`: TypeBox produces JSON Schema by construction, so the schema
 * objects drop straight into `components.schemas` with no second schema system
 * and no Zod.
 *
 * It is intentionally DISTINCT from `public/openai.json` (the plugin-manifest
 * that pins the 8-tool surface): this file does not redefine that surface, it
 * describes the REST endpoints those tools map onto. The operation set stays in
 * one-to-one correspondence with the frozen 8 tools.
 *
 * OpenAI Action field limits are respected: endpoint summary/description ≤300
 * chars, parameter description ≤700 chars. `assertOpenAiLimits()` enforces this
 * and the build test calls it.
 */
import { RunRequest, RunResult } from "@llm-pipe/core";

/** OpenAI Custom GPT Action field-length limits. */
export const OPENAI_ENDPOINT_DESC_LIMIT = 300;
export const OPENAI_PARAM_DESC_LIMIT = 700;

/**
 * Strip TypeBox's `$id`/`$schema` annotations from an embedded schema so the
 * object is a plain inline JSON Schema in `components.schemas`. TypeBox emits
 * JSON Schema by construction; we only remove the identity keywords that would
 * otherwise collide when inlined under a component name.
 */
function inlineSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // TypeBox stamps `$id` on every named sub-schema (e.g. ChannelResult appears
  // twice inside RunResult). Inlined under one component name those duplicate
  // `$id`s would collide in Ajv, so rebuild the tree without identity keywords.
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "$id" || key === "$schema") continue;
        out[key] = strip(value);
      }
      return out;
    }
    return node;
  };
  return strip(schema) as Record<string, unknown>;
}

export interface OpenApiOptions {
  /** Public base URL of the deployed server (e.g. https://calane.onrender.com). */
  serverUrl?: string;
}

/**
 * Build the OpenAPI 3.1 document. `serverUrl` defaults to the
 * `CALANE_PUBLIC_URL` env var, then a localhost placeholder the operator edits
 * after deploy.
 */
export function buildOpenApiDocument(options: OpenApiOptions = {}): Record<string, unknown> {
  const serverUrl = options.serverUrl ?? process.env.CALANE_PUBLIC_URL ?? "http://localhost:8787";

  const doc = {
    openapi: "3.1.0",
    info: {
      title: "llm-pipeline-kernel",
      version: "0.1.0",
      description:
        "Run versioned, schema-validated, multi-model analysis pipelines and " +
        "fetch traceable run results. Coarse REST surface matching the kernel's 8 tools.",
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        // Reuses the S11 CALANE_API_TOKEN bearer path; no OAuth needed for the GPT.
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        RunRequest: inlineSchema(RunRequest as unknown as Record<string, unknown>),
        RunResult: inlineSchema(RunResult as unknown as Record<string, unknown>),
        Error: {
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
        },
      },
    },
    // Bearer required for every operation by default.
    security: [{ bearerAuth: [] }],
    paths: {
      "/runs": {
        post: {
          operationId: "run_pipeline",
          summary: "Run a pipeline",
          description:
            "Execute a named pipeline against an input string and store the run. " +
            "Returns the full RunResult (channels, synthesis, validation, source hashes).",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/RunRequest" } },
            },
          },
          responses: {
            "201": {
              description: "The completed run result.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/RunResult" } },
              },
            },
            "400": errorResponse("Missing pipelineId or input."),
          },
        },
        get: {
          operationId: "list_runs",
          summary: "List run ids",
          description: "List the ids of all stored runs.",
          responses: {
            "200": {
              description: "The stored run ids.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { runs: { type: "array", items: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
      },
      "/runs/{runId}": {
        get: {
          operationId: "get_run_result",
          summary: "Get a run result",
          description: "Fetch a single stored run result by its id.",
          parameters: [runIdParam()],
          responses: {
            "200": {
              description: "The run result.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/RunResult" } },
              },
            },
            "404": errorResponse("Run not found."),
          },
        },
      },
      "/runs/{runId}/rerun-channel": {
        post: {
          operationId: "rerun_channel",
          summary: "Re-run one channel",
          description:
            "Re-run a single channel using an existing run's stored input and return the fresh channel.",
          parameters: [runIdParam()],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["channelId"],
                  properties: {
                    channelId: {
                      type: "string",
                      description: "The id of the channel to re-run.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "The fresh channel result and its new run id.",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "404": errorResponse("Run or channel not found."),
          },
        },
      },
      "/runs/{runId}/export": {
        get: {
          operationId: "export_run_bundle",
          summary: "Export a run bundle",
          description:
            "Export a reproducible run bundle for a stored run. Set redacted=true to strip obvious secrets from raw outputs.",
          parameters: [
            runIdParam(),
            {
              name: "redacted",
              in: "query",
              required: false,
              description: "When true, redact obvious secrets from raw outputs in the bundle.",
              schema: { type: "boolean" },
            },
          ],
          responses: {
            "200": {
              description: "The exported bundle descriptor (paths + canonical reference).",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "404": errorResponse("Run not found."),
          },
        },
      },
      "/pipelines": {
        get: {
          operationId: "list_pipelines",
          summary: "List pipelines",
          description: "List the ids of the pipelines available in the registry.",
          responses: {
            "200": {
              description: "The available pipeline ids.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { pipelines: { type: "array", items: { type: "string" } } },
                  },
                },
              },
            },
          },
        },
      },
      "/pipelines/{pipelineId}": {
        get: {
          operationId: "get_pipeline_spec",
          summary: "Get a pipeline spec",
          description: "Fetch the resolved spec and source metadata for one pipeline by id.",
          parameters: [pipelineIdParam()],
          responses: {
            "200": {
              description: "The resolved pipeline spec and source metadata.",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "404": errorResponse("Pipeline not found."),
          },
        },
      },
      "/pipelines/{pipelineId}/validate": {
        post: {
          operationId: "validate_pipeline",
          summary: "Validate a pipeline",
          description:
            "Validate a pipeline definition by id (schema, prompts, providers) and return a structured report.",
          parameters: [pipelineIdParam()],
          responses: {
            "200": {
              description: "The validation report.",
              content: { "application/json": { schema: { type: "object" } } },
            },
            "404": errorResponse("Pipeline not found."),
          },
        },
      },
    },
  };

  return doc;
}

function runIdParam(): Record<string, unknown> {
  return {
    name: "runId",
    in: "path",
    required: true,
    description: "The id of the stored run.",
    schema: { type: "string" },
  };
}

function pipelineIdParam(): Record<string, unknown> {
  return {
    name: "pipelineId",
    in: "path",
    required: true,
    description: "The id of the pipeline in the registry.",
    schema: { type: "string" },
  };
}

function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

/** Operation ids that must stay 1:1 with the frozen 8-tool surface. */
export const OPENAPI_OPERATION_IDS = [
  "run_pipeline",
  "list_runs",
  "get_run_result",
  "rerun_channel",
  "export_run_bundle",
  "list_pipelines",
  "get_pipeline_spec",
  "validate_pipeline",
] as const;

/**
 * Assert the document respects OpenAI's Custom GPT Action field-length limits:
 * each operation summary/description ≤300 chars and each parameter description
 * ≤700 chars. Throws with the offending location on violation.
 */
export function assertOpenAiLimits(doc: Record<string, unknown>): void {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, any>>;
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const summary = op.summary as string | undefined;
      const description = op.description as string | undefined;
      if (summary && summary.length > OPENAI_ENDPOINT_DESC_LIMIT) {
        throw new Error(
          `${method.toUpperCase()} ${path}: summary exceeds ${OPENAI_ENDPOINT_DESC_LIMIT} chars`,
        );
      }
      if (description && description.length > OPENAI_ENDPOINT_DESC_LIMIT) {
        throw new Error(
          `${method.toUpperCase()} ${path}: description exceeds ${OPENAI_ENDPOINT_DESC_LIMIT} chars`,
        );
      }
      for (const param of (op.parameters ?? []) as Array<Record<string, unknown>>) {
        const pdesc = param.description as string | undefined;
        if (pdesc && pdesc.length > OPENAI_PARAM_DESC_LIMIT) {
          throw new Error(
            `${method.toUpperCase()} ${path}: parameter ${String(param.name)} description exceeds ${OPENAI_PARAM_DESC_LIMIT} chars`,
          );
        }
      }
    }
  }
}

/** Back-compat: the previous tiny hand-authored doc consumers may import. */
export const openapi = buildOpenApiDocument();
