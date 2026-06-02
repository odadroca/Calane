import type { ProviderSpec } from "../specs/ProviderSpec.js";
import type { Usage } from "../specs/RunResult.js";

export interface ProviderRequest {
  runId: string;
  channelId: string;
  /** Fully rendered prompt text. */
  prompt: string;
  /** Resolved JSON Schema object for structured output, if any. */
  outputSchema?: unknown;
  spec: ProviderSpec;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProviderResponse {
  /** Raw, unparsed model output text. Always preserved, even when invalid. */
  rawOutput: string;
  model: string | null;
  usage: Usage;
  /** Set when the provider itself signals a refusal. */
  refused?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * ProviderAdapterInterface — a functional plugin. Covers both direct provider
 * execution and delegated-agent execution (delegated agents implement the same
 * call surface, receiving an instruction bundle and returning a structured
 * result through MCP/OpenAI-style JSON).
 */
export interface ProviderAdapterInterface {
  /** Adapter type key matched against ProviderSpec.type. */
  readonly type: string;
  execute(request: ProviderRequest): Promise<ProviderResponse>;
}

/** Simple in-process registry mapping ProviderSpec.type -> adapter. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapterInterface>();

  register(adapter: ProviderAdapterInterface): this {
    this.adapters.set(adapter.type, adapter);
    return this;
  }

  get(type: string): ProviderAdapterInterface {
    const adapter = this.adapters.get(type);
    if (!adapter) throw new Error(`No provider adapter registered for type "${type}"`);
    return adapter;
  }

  has(type: string): boolean {
    return this.adapters.has(type);
  }
}
