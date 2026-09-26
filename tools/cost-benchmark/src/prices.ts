// Public list prices in USD per million tokens. Update when vendors change prices.
// Source: Anthropic API model table (2026-06-24).
export interface ModelPrice {
  input: number;
  output: number;
  cacheWriteMultiplier: number; // 5-minute cache write
  cacheReadMultiplier: number;
}

export const CLAUDE_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
};

export const BATCH_DISCOUNT = 0.5;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function claudeCost(model: string, usage: Usage): number {
  const p = CLAUDE_PRICES[model];
  if (!p) throw new Error(`No price for model ${model}`);
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  return (
    usage.input_tokens * perToken(p.input) +
    (usage.cache_creation_input_tokens ?? 0) * perToken(p.input * p.cacheWriteMultiplier) +
    (usage.cache_read_input_tokens ?? 0) * perToken(p.input * p.cacheReadMultiplier) +
    usage.output_tokens * perToken(p.output)
  );
}
