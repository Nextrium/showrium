// OpenAI-compatible providers (OpenRouter, DeepSeek). Prices come from the provider where it
// publishes them (OpenRouter's public model list); DeepSeek prices are a table below.
import { z } from "zod";

export interface CompatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number; // DeepSeek
  prompt_tokens_details?: { cached_tokens?: number } | null; // OpenRouter
}

export interface CompatProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  cost: (usage: CompatUsage) => number;
}

interface OpenRouterModel {
  id: string;
  pricing: { prompt: string; completion: string; input_cache_read?: string };
}

export async function openRouterProviders(apiKey: string): Promise<CompatProvider[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter model list failed: HTTP ${res.status}`);
  const { data } = (await res.json()) as { data: OpenRouterModel[] };

  const wanted = (process.env.OPENROUTER_MODELS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const picked: OpenRouterModel[] = [];
  if (wanted.length > 0) {
    for (const id of wanted) {
      const model = data.find((m) => m.id === id);
      if (!model) {
        const hint = data.filter((m) => m.id.includes(id.split("/")[1]?.slice(0, 8) ?? id)).slice(0, 5).map((m) => m.id);
        throw new Error(`OpenRouter model "${id}" not found. Close matches: ${hint.join(", ") || "none"}`);
      }
      picked.push(model);
    }
  } else {
    // Default comparison: Claude Haiku and DeepSeek's cheapest ("flash") model.
    const haiku = data.find((m) => m.id.startsWith("anthropic/claude-haiku"));
    const deepseek =
      data.find((m) => m.id.startsWith("deepseek/") && m.id.includes("flash")) ??
      data.find((m) => m.id.startsWith("deepseek/"));
    for (const m of [haiku, deepseek]) if (m) picked.push(m);
  }

  return picked.map((m) => {
    const prompt = Number(m.pricing.prompt);
    const completion = Number(m.pricing.completion);
    const cacheRead = Number(m.pricing.input_cache_read ?? m.pricing.prompt);
    return {
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey,
      model: m.id,
      cost: (u) => {
        const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
        return (u.prompt_tokens - cached) * prompt + cached * cacheRead + u.completion_tokens * completion;
      },
    };
  });
}

// USD per million tokens, off-peak. DeepSeek charges double at peak
// (Mon-Fri 01:00-04:00 and 06:00-10:00 UTC). Source: 3rd-party summaries of
// DeepSeek's pricing page (Sep 2026); confirm at platform.deepseek.com.
const DEEPSEEK_PRICES = {
  flash: { miss: 0.15, hit: 0.003, out: 0.6 },
  pro: { miss: 0.66, hit: 0.022, out: 1.98 },
};

function deepSeekPeak(now: Date): boolean {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

export async function deepSeekProvider(apiKey: string): Promise<CompatProvider> {
  const res = await fetch("https://api.deepseek.com/models", { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`DeepSeek model list failed: HTTP ${res.status}`);
  const ids = ((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id);
  const model = process.env.DEEPSEEK_MODEL ?? ids.find((id) => id.includes("flash")) ?? ids[0];
  if (!model || !ids.includes(model)) throw new Error(`DeepSeek model "${model}" not found. Available: ${ids.join(", ")}`);
  const table = model.includes("pro") ? DEEPSEEK_PRICES.pro : DEEPSEEK_PRICES.flash;
  return {
    name: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey,
    model,
    cost: (u) => {
      const multiplier = deepSeekPeak(new Date()) ? 2 : 1;
      const hit = u.prompt_cache_hit_tokens ?? 0;
      const perToken = (perMillion: number) => (perMillion * multiplier) / 1_000_000;
      return (u.prompt_tokens - hit) * perToken(table.miss) + hit * perToken(table.hit) + u.completion_tokens * perToken(table.out);
    },
  };
}

export async function compatChat<T extends z.ZodType>(
  provider: CompatProvider,
  system: string,
  user: string,
  schema: T,
  maxTokens: number,
): Promise<{ parsed: z.infer<T> | null; usage: CompatUsage }> {
  const shape = JSON.stringify(z.toJSONSchema(schema));
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${user}\n\nRespond with only a JSON object matching this JSON Schema:\n${shape}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${provider.name}/${provider.model}: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { choices: { message: { content: string | null } }[]; usage: CompatUsage };
  let parsed: z.infer<T> | null = null;
  try {
    const result = schema.safeParse(JSON.parse(body.choices[0]?.message.content ?? ""));
    if (result.success) parsed = result.data;
  } catch {
    parsed = null;
  }
  return { parsed, usage: body.usage };
}
