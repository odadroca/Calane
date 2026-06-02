import type { ProviderAdapterInterface, ProviderRequest, ProviderResponse } from "@llm-pipe/core";

/**
 * Placeholder delegated-agent adapter. In delegated_agent mode the kernel
 * produces an instruction bundle (carrying runId + channelId, per the security
 * baseline) and hands it to an external agent/LLM/tool surface, which returns a
 * structured result through MCP or an OpenAI-style JSON callback.
 *
 * This MVP placeholder supports a synchronous resolver function so the path is
 * exercisable in tests. Real transports (MCP client, HTTP callback with signing)
 * are future work and intentionally NOT implemented here. Callback signing is
 * planned but out of scope for the MVP.
 */
export type DelegatedResolver = (bundle: InstructionBundle) => Promise<string> | string;

export interface InstructionBundle {
  runId: string;
  channelId: string;
  prompt: string;
  outputSchema?: unknown;
  model: string | null;
}

export class DelegatedAgentProvider implements ProviderAdapterInterface {
  readonly type = "delegated-agent";

  constructor(private readonly resolver?: DelegatedResolver) {}

  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    const model = request.spec.model ?? null;
    const bundle: InstructionBundle = {
      runId: request.runId,
      channelId: request.channelId,
      prompt: request.prompt,
      outputSchema: request.outputSchema,
      model,
    };

    if (!this.resolver) {
      throw new Error(
        "delegated-agent provider has no resolver configured (MVP placeholder; wire an MCP/HTTP callback transport)",
      );
    }

    const rawOutput = await this.resolver(bundle);
    return {
      rawOutput,
      model,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
      metadata: { delegated: true },
    };
  }
}
