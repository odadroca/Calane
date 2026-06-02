import { Value } from "@sinclair/typebox/value";
import { PipelineSpec } from "../specs/PipelineSpec.js";

/**
 * A single structural validation problem. `check` identifies which structural
 * rule failed so callers (CLI/REST/MCP) can render or branch on it.
 */
export interface ValidationIssue {
  check: "spec_schema" | "prompt_missing" | "schema_missing" | "provider_missing" | "cycle";
  message: string;
  /** JSON-pointer-ish location within the spec, when meaningful. */
  path?: string;
}

export interface PipelineValidationReport {
  valid: boolean;
  pipelineId: string | null;
  issues: ValidationIssue[];
}

/**
 * Dependencies the validator needs to resolve referenced files and provider
 * registration. Decoupled from any concrete registry/provider implementation so
 * the same validator backs CLI, REST, and MCP.
 */
export interface PipelineValidatorDeps {
  /** Load a prompt template by its registry-relative path. Throws if missing. */
  loadPrompt(relativePath: string): Promise<string>;
  /** Load + parse a JSON Schema file by its registry-relative path. Throws if missing/unparseable. */
  loadSchema(relativePath: string): Promise<unknown>;
  /** True when a provider adapter is registered for the given `ProviderSpec.type`. */
  hasProvider(type: string): boolean;
}

/**
 * Structural validation of a pipeline definition. This is NOT runtime
 * correctness (running the pipeline is `run_pipeline`) and NOT linting
 * (prompt length, style); it answers "is this pipeline well-formed and are its
 * references resolvable?".
 *
 * Checks performed:
 *  1. Spec conforms to the PipelineSpec TypeBox schema.
 *  2. All referenced prompt files exist.
 *  3. All referenced schema files exist and parse as JSON Schema (object).
 *  4. All declared providers' `type` keys are registered.
 *  5. No cycles in channel dependencies (no-op while channels are flat; the
 *     scaffold is in place for Phase 4 dependency graphs).
 */
export class PipelineValidator {
  constructor(private readonly deps: PipelineValidatorDeps) {}

  async validate(rawSpec: unknown): Promise<PipelineValidationReport> {
    const issues: ValidationIssue[] = [];

    // Check 1: spec schema. If this fails, downstream checks would be unsafe.
    const schemaErrors = [...Value.Errors(PipelineSpec, rawSpec)];
    if (schemaErrors.length > 0) {
      for (const e of schemaErrors.slice(0, 20)) {
        issues.push({ check: "spec_schema", message: e.message, path: e.path || "/" });
      }
      return { valid: false, pipelineId: pipelineIdOf(rawSpec), issues };
    }

    const spec = rawSpec as PipelineSpec;
    const channels = [...spec.channels, ...(spec.synthesis ? [spec.synthesis] : [])];

    // Check 4: declared providers registered.
    for (let i = 0; i < spec.providers.length; i++) {
      const p = spec.providers[i]!;
      if (!this.deps.hasProvider(p.type)) {
        issues.push({
          check: "provider_missing",
          message: `Provider "${p.id}" uses unregistered adapter type "${p.type}"`,
          path: `/providers/${i}`,
        });
      }
    }

    // Checks 2 + 3: referenced files resolve.
    for (const channel of channels) {
      try {
        await this.deps.loadPrompt(channel.prompt);
      } catch (err) {
        issues.push({
          check: "prompt_missing",
          message: `Channel "${channel.id}" prompt not found: ${channel.prompt} (${errText(err)})`,
          path: `/channels/${channel.id}/prompt`,
        });
      }

      if (channel.outputSchema) {
        try {
          const loaded = await this.deps.loadSchema(channel.outputSchema);
          if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
            issues.push({
              check: "schema_missing",
              message: `Channel "${channel.id}" outputSchema is not a JSON Schema object: ${channel.outputSchema}`,
              path: `/channels/${channel.id}/outputSchema`,
            });
          }
        } catch (err) {
          issues.push({
            check: "schema_missing",
            message: `Channel "${channel.id}" outputSchema not found or unparseable: ${channel.outputSchema} (${errText(err)})`,
            path: `/channels/${channel.id}/outputSchema`,
          });
        }
      }
    }

    // Check 5: channel-dependency graph integrity. Channels may declare
    // `dependsOn`; a dependency on an unknown channel id or any cycle is
    // rejected. Synthesis is not part of the `channels` dependency graph (it runs
    // after all channels), so only `spec.channels` participate.
    for (const issue of detectGraphIssues(spec.channels)) issues.push(issue);

    return { valid: issues.length === 0, pipelineId: spec.id, issues };
  }
}

function pipelineIdOf(raw: unknown): string | null {
  if (raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string") {
    return (raw as { id: string }).id;
  }
  return null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Detect dependency-graph problems among channels: references to unknown channel
 * ids and cycles. Uses Kahn's algorithm — any channel that cannot be ordered
 * participates in (or depends on) a cycle. Returns one issue per problem found.
 */
function detectGraphIssues(channels: { id: string; dependsOn?: string[] }[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set(channels.map((c) => c.id));

  // Unknown-dependency references.
  for (const c of channels) {
    for (const dep of c.dependsOn ?? []) {
      if (!ids.has(dep)) {
        issues.push({
          check: "cycle",
          message: `Channel "${c.id}" dependsOn unknown channel "${dep}"`,
          path: `/channels/${c.id}/dependsOn`,
        });
      }
    }
  }
  if (issues.length > 0) return issues;

  // Cycle detection via Kahn's algorithm.
  const indegree = new Map<string, number>();
  for (const c of channels) {
    indegree.set(c.id, (c.dependsOn ?? []).filter((d) => ids.has(d)).length);
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let resolved = 0;
  const removed = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    removed.add(id);
    resolved += 1;
    for (const c of channels) {
      if (removed.has(c.id)) continue;
      if ((c.dependsOn ?? []).includes(id)) {
        const next = (indegree.get(c.id) ?? 0) - 1;
        indegree.set(c.id, next);
        if (next === 0) queue.push(c.id);
      }
    }
  }
  if (resolved < channels.length) {
    const cyclic = channels
      .map((c) => c.id)
      .filter((id) => !removed.has(id))
      .join(", ");
    issues.push({
      check: "cycle",
      message: `Cyclic channel dependencies detected among: ${cyclic}`,
      path: "/channels",
    });
  }
  return issues;
}
