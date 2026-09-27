// AI provider chain (ADR-0004): try each provider in order; the first schema-valid answer wins.
// Providers are plain objects so tests can inject fakes. Costs are reported in micro-dollars.
import type { z } from "zod";

export interface GenerateRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** Hard stop per provider call. */
  timeoutMs?: number;
}

export interface ProviderResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface Provider {
  name: string;
  /** USD per million tokens. */
  price: { input: number; output: number };
  generate(req: GenerateRequest): Promise<ProviderResult>;
}

export interface Generated<T> {
  data: T;
  model: string;
  costMicroUsd: number;
  attempts: { model: string; error: string }[];
}

export class AllProvidersFailedError extends Error {
  constructor(readonly attempts: { model: string; error: string }[]) {
    super(`All AI providers failed: ${attempts.map((a) => `${a.model}: ${a.error}`).join("; ")}`);
    this.name = "AllProvidersFailedError";
  }
}

/** Pulls the first JSON object out of a model reply (some models wrap JSON in prose or fences). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function generateStructured<T extends z.ZodType>(
  providers: Provider[],
  req: GenerateRequest,
  schema: T,
  validate?: (data: z.infer<T>) => string | null,
): Promise<Generated<z.infer<T>>> {
  const attempts: { model: string; error: string }[] = [];
  for (const provider of providers) {
    try {
      const result = await provider.generate(req);
      const parsed = schema.safeParse(extractJson(result.text));
      if (!parsed.success) throw new Error(`schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      const problem = validate?.(parsed.data);
      if (problem) throw new Error(`validation: ${problem}`);
      // Tokens x USD-per-million-tokens = micro-USD.
      const cost = result.inputTokens * provider.price.input + result.outputTokens * provider.price.output;
      return { data: parsed.data, model: provider.name, costMicroUsd: Math.round(cost), attempts };
    } catch (error) {
      attempts.push({ model: provider.name, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    }
  }
  throw new AllProvidersFailedError(attempts);
}

// --- Providers ----------------------------------------------------------------

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** OpenRouter (OpenAI-compatible). Also used to reach DeepSeek and Gemini. */
export function openRouterProvider(opts: { apiKey: string; model: string; price: { input: number; output: number }; fetch?: FetchLike; appUrl?: string }): Provider {
  const doFetch = opts.fetch ?? fetch;
  return {
    name: opts.model,
    price: opts.price,
    async generate(req) {
      const res = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          ...(opts.appUrl ? { "HTTP-Referer": opts.appUrl, "X-Title": "Showrium" } : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: req.maxTokens,
          response_format: { type: "json_object" },
          // Prefer hosts that don't retain prompts (OpenRouter provider routing).
          provider: { data_collection: "deny" },
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new Error("empty reply");
      return { text, inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
    },
  };
}

/** Cloudflare Workers AI binding: last resort, inside the free daily allowance. */
export function workersAiProvider(opts: { ai: Ai; model: string }): Provider {
  return {
    name: opts.model,
    price: { input: 0, output: 0 },
    async generate(req) {
      const out = (await opts.ai.run(opts.model as Parameters<Ai["run"]>[0], {
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        max_tokens: req.maxTokens,
      } as never)) as { response?: string };
      if (!out?.response) throw new Error("empty reply");
      return { text: out.response, inputTokens: 0, outputTokens: 0 };
    },
  };
}

/** Deterministic fake for tests and local development only. */
export function fakeProvider(reply: (req: GenerateRequest) => string, name = "fake"): Provider {
  return { name, price: { input: 0, output: 0 }, generate: async (req) => ({ text: reply(req), inputTokens: 100, outputTokens: 100 }) };
}
