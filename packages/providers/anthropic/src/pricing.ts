/**
 * Model pricing for Anthropic `claude-` models, in USD per 1,000,000 tokens.
 *
 * Hardcoded with an override hook (see {@link computeCostUsd}'s `pricing`
 * argument and {@link AnthropicProviderOptions.pricing}). Prices are point-in-time
 * and may drift; the override hook lets a caller supply current numbers without a
 * code change. Source: published Anthropic model pricing.
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Resolve a price entry for a model id. Matches the longest known prefix so that
 * dated snapshots (e.g. `claude-haiku-4-5-20251001`) resolve to their base price.
 */
export function priceForModel(
  model: string,
  pricing: Record<string, ModelPrice> = DEFAULT_PRICING,
): ModelPrice | null {
  if (pricing[model]) return pricing[model] ?? null;
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(pricing)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best ? best.price : null;
}

/**
 * Compute USD cost from token usage. Returns `null` when the model is not in the
 * pricing table (cost is unknown, never silently zero).
 */
export function computeCostUsd(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  pricing: Record<string, ModelPrice> = DEFAULT_PRICING,
): number | null {
  const price = priceForModel(model, pricing);
  if (!price || inputTokens === null || outputTokens === null) return null;
  return (
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok
  );
}
