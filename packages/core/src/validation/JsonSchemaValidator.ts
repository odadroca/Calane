import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { canonicalJson } from "../util/hash.js";

export interface ParseResult {
  /** "valid" | "invalid_json" | "schema_error" */
  outcome: "valid" | "invalid_json" | "schema_error";
  parsed: unknown;
  errors: unknown[];
}

/**
 * JsonSchemaValidator — wraps Ajv. Compiles TypeBox-produced schemas and
 * external JSON Schema files identically. Never silently accepts invalid JSON.
 */
export class JsonSchemaValidator {
  private readonly ajv: Ajv;
  // Keyed by canonical schema content so the same schema file (re-parsed into a
  // fresh object per load) compiles only once — avoids Ajv duplicate-$id errors.
  private readonly cache = new Map<string, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);
  }

  /** Compile (and cache) a validator for a schema object. */
  compile(schema: object): ValidateFunction {
    const key = canonicalJson(schema);
    let validate = this.cache.get(key);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.cache.set(key, validate);
    }
    return validate;
  }

  /**
   * Parse raw text as JSON and validate against an optional schema.
   * Raw text is never discarded; callers persist it regardless of outcome.
   */
  parseAndValidate(raw: string, schema?: object | null): ParseResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch (err) {
      return { outcome: "invalid_json", parsed: null, errors: [String(err)] };
    }
    if (!schema) {
      return { outcome: "valid", parsed, errors: [] };
    }
    const validate = this.compile(schema);
    const ok = validate(parsed);
    if (ok) return { outcome: "valid", parsed, errors: [] };
    return { outcome: "schema_error", parsed, errors: validate.errors ?? [] };
  }
}

/**
 * Extract the first JSON object/array from text. Models often wrap JSON in
 * prose or ```json fences; we strip a fence if present, else take the substring
 * between the first brace/bracket and its matching last one.
 */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]!.trim() : trimmed;
  const firstObj = body.indexOf("{");
  const firstArr = body.indexOf("[");
  const start =
    firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start === -1) return body;
  const openChar = body[start];
  const closeChar = openChar === "{" ? "}" : "]";
  const end = body.lastIndexOf(closeChar);
  if (end === -1 || end < start) return body;
  return body.slice(start, end + 1);
}
