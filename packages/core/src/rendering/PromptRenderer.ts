import type { ChannelResult } from "../specs/RunResult.js";

/** Parsed + raw output of a single upstream channel, keyed by channel id. */
export interface UpstreamOutput {
  /** The parsed (validated-or-not) JSON output, JSON-stringified for the prompt. */
  parsed: string;
  /** The raw provider output text. */
  raw: string;
}

export interface PromptContext {
  input: string;
  channelResults?: ChannelResult[];
  previousSynthesis?: ChannelResult | null;
  recursionDepth?: number;
  runId?: string;
  /**
   * Per-upstream-channel outputs, keyed by channel id, exposing the new DAG
   * template variables `{{channel_results.<id>.parsed}}` and
   * `{{channel_results.<id>.raw}}`. Empty/absent for flat pipelines.
   */
  upstream?: Record<string, UpstreamOutput>;
}

/**
 * PromptRenderer — substitutes a small, explicit set of template variables:
 *   {{input}} {{channel_results}} {{previous_synthesis}}
 *   {{recursion_depth}} {{run_id}}
 * and, for DAG pipelines, the additive per-upstream-channel variables:
 *   {{channel_results.<id>.parsed}} {{channel_results.<id>.raw}}
 * Unknown variables are left untouched so authoring mistakes are visible.
 */
export class PromptRenderer {
  render(template: string, ctx: PromptContext): string {
    const channelResults = ctx.channelResults
      ? JSON.stringify(
          ctx.channelResults.map((c) => ({
            channelId: c.channelId,
            status: c.status,
            output: c.parsedOutput,
          })),
          null,
          2,
        )
      : "";
    const previousSynthesis = ctx.previousSynthesis
      ? JSON.stringify(ctx.previousSynthesis.parsedOutput, null, 2)
      : "";

    const vars: Record<string, string> = {
      input: ctx.input,
      channel_results: channelResults,
      previous_synthesis: previousSynthesis,
      recursion_depth: String(ctx.recursionDepth ?? 0),
      run_id: ctx.runId ?? "",
    };

    // First pass: dotted per-upstream-channel variables. Matched before the
    // simple `\w+` pass so `channel_results.<id>.<field>` is handled here and the
    // bare `{{channel_results}}` token is left for the simple pass.
    const upstream = ctx.upstream ?? {};
    let out = template.replace(
      /\{\{\s*channel_results\.([\w-]+)\.(parsed|raw)\s*\}\}/g,
      (match, id: string, field: "parsed" | "raw") => {
        const u = upstream[id];
        if (!u) return match; // unknown upstream id: leave visible
        return field === "parsed" ? u.parsed : u.raw;
      },
    );

    // Second pass: the original simple-variable substitution.
    out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
      key in vars ? vars[key]! : match,
    );

    return out;
  }
}
