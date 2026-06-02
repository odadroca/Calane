import { createHash, randomBytes } from "node:crypto";

/** Content-addressed sha256 hash (hex) of a string, prefixed with "sha256:". */
export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Canonical JSON stringify: object keys sorted recursively so the hash is
 * stable regardless of authoring key order. Used for pipeline/schema hashing.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Generate a run id like "run_ab12cd34ef56". */
export function generateRunId(): string {
  return `run_${randomBytes(8).toString("hex")}`;
}
