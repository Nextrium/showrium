// Cost benchmark: runs sample contexts through the real pipeline shape
// (brief -> platform variants) on every provider that has a key, and reports
// measured cost per post and output validity per model.
//
//   pnpm bench:dry   # no API calls, token estimates only
//   pnpm bench       # real calls (spends a few cents); reads keys from the repo-root .env
//
// Keys (any subset): ANTHROPIC_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY,
// CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Workers AI fallback).
// Optional: OPENROUTER_MODELS (comma-separated ids), DEEPSEEK_MODEL, WORKERS_AI_MODEL.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { FIXTURES, PERSONA, PLATFORMS, type Fixture } from "./fixtures.js";
import { BATCH_DISCOUNT, claudeCost, type Usage } from "./prices.js";
import { compatChat, deepSeekProvider, openRouterProviders, type CompatProvider } from "./openai-compatible.js";

const DRY_RUN = process.argv.includes("--dry-run");
const CLAUDE_PRIMARY = "claude-haiku-4-5";
const CLAUDE_LONGFORM = "claude-sonnet-5";
const WORKERS_AI_MODEL = process.env.WORKERS_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";

// Frozen system prompt: identical bytes on every call so the persona prefix can be cached.
const SYSTEM = `You are Showrium's writing engine. You turn one piece of context into platform-native posts
written in the user's own voice. Never invent facts, numbers or achievements that are not in the context.
Follow each platform's conventions: LinkedIn story format; X under 280 characters with no URLs;
Instagram caption with up to 5 relevant hashtags; Threads and Bluesky short and conversational;
TikTok and YouTube Shorts as 30-45 second spoken scripts with an on-screen text hook.

User persona:
${PERSONA}`;

const BriefSchema = z.object({
  angle: z.string(),
  key_points: z.array(z.string()),
  hook: z.string(),
  call_to_action: z.string(),
});
const VariantsSchema = z.object({
  variants: z.array(z.object({ platform: z.enum(PLATFORMS), text: z.string() })),
});
const ArticleSchema = z.object({ title: z.string(), body_markdown: z.string() });

interface StepResult {
  fixture: string;
  step: string;
  provider: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  valid: boolean;
  output?: unknown;
}
const results: StepResult[] = [];

// A runner executes one step on one model and records the result.
type Runner = {
  provider: string;
  model: string;
  longformModel: string;
  run: <T extends z.ZodType>(fixture: Fixture, step: string, prompt: string, schema: T, maxTokens: number, longform?: boolean) => Promise<z.infer<T> | null>;
};

function claudeRunner(client: Anthropic): Runner {
  return {
    provider: "anthropic",
    model: CLAUDE_PRIMARY,
    longformModel: CLAUDE_LONGFORM,
    async run(fixture, step, prompt, schema, maxTokens, longform) {
      const model = longform ? CLAUDE_LONGFORM : CLAUDE_PRIMARY;
      if (DRY_RUN) {
        const usage: Usage = { input_tokens: Math.ceil((SYSTEM.length + prompt.length) / 4), output_tokens: maxTokens / 2 };
        record(fixture, step, "anthropic", model, usage.input_tokens, 0, usage.output_tokens, claudeCost(model, usage), 0, true);
        return null;
      }
      const started = Date.now();
      const response = await client.messages.parse({
        model,
        max_tokens: maxTokens,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: prompt }],
        output_config: { format: zodOutputFormat(schema) },
      });
      const u = response.usage;
      record(fixture, step, "anthropic", model, u.input_tokens, u.cache_read_input_tokens ?? 0, u.output_tokens,
        claudeCost(model, u), Date.now() - started, response.parsed_output !== null, response.parsed_output);
      return response.parsed_output;
    },
  };
}

function compatRunner(p: CompatProvider): Runner {
  return {
    provider: p.name,
    model: p.model,
    longformModel: p.model,
    async run(fixture, step, prompt, schema, maxTokens) {
      const started = Date.now();
      const { parsed, usage } = await compatChat(p, SYSTEM, prompt, schema, maxTokens);
      const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
      record(fixture, step, p.name, p.model, usage.prompt_tokens, cached, usage.completion_tokens,
        p.cost(usage), Date.now() - started, parsed !== null, parsed);
      return parsed;
    },
  };
}

function record(fixture: Fixture, step: string, provider: string, model: string, inputTokens: number,
  cachedTokens: number, outputTokens: number, costUsd: number, latencyMs: number, valid: boolean, output?: unknown): void {
  results.push({ fixture: fixture.id, step, provider, model, inputTokens, cachedTokens, outputTokens, costUsd, latencyMs, valid, output });
}

async function runPipeline(runner: Runner): Promise<void> {
  for (const fixture of FIXTURES) {
    try {
      const brief = await runner.run(fixture, "brief",
        `Mode: ${fixture.mode}\nContext:\n${fixture.context}\n\nWrite a content brief.`, BriefSchema, 1024);
      await runner.run(fixture, "variants_x8",
        `Mode: ${fixture.mode}\nContext:\n${fixture.context}\n\nBrief:\n${JSON.stringify(brief ?? {})}\n\n` +
          `Write one post for each platform: ${PLATFORMS.join(", ")}.`, VariantsSchema, 8192);
      if (fixture.mode === "expert_take") {
        await runner.run(fixture, "longform_article",
          `Context:\n${fixture.context}\n\nWrite a 600-800 word Dev.to article in the user's voice.`, ArticleSchema, 4096, true);
      }
    } catch (error) {
      console.error(`[${runner.provider}/${runner.model}] ${fixture.id} failed:`, error instanceof Error ? error.message : error);
      record(fixture, "error", runner.provider, runner.model, 0, 0, 0, 0, 0, false);
    }
  }
}

async function workersAiFallback(): Promise<void> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (DRY_RUN || !account || !token) return;
  for (const fixture of FIXTURES) {
    const started = Date.now();
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${WORKERS_AI_MODEL}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Write one LinkedIn post (mode: ${fixture.mode}) from this context:\n${fixture.context}` },
        ],
      }),
    });
    const body = (await res.json()) as { success?: boolean; result?: { response?: string } };
    // Cost: within the 10k free neurons/day; check the Workers AI dashboard for neuron usage.
    record(fixture, "fallback_linkedin_post", "workers-ai", WORKERS_AI_MODEL, 0, 0, 0, 0, Date.now() - started,
      res.ok && body.success === true && (body.result?.response?.length ?? 0) > 50);
  }
}

async function main(): Promise<void> {
  const runners: Runner[] = [];
  if (DRY_RUN || process.env.ANTHROPIC_API_KEY) runners.push(claudeRunner(new Anthropic()));
  if (!DRY_RUN && process.env.OPENROUTER_API_KEY) {
    for (const p of await openRouterProviders(process.env.OPENROUTER_API_KEY)) runners.push(compatRunner(p));
  }
  if (!DRY_RUN && process.env.DEEPSEEK_API_KEY) runners.push(compatRunner(await deepSeekProvider(process.env.DEEPSEEK_API_KEY)));
  if (runners.length === 0) {
    console.error("No AI keys found. Set ANTHROPIC_API_KEY, OPENROUTER_API_KEY or DEEPSEEK_API_KEY in the repo-root .env, or use --dry-run.");
    process.exit(1);
  }
  for (const runner of runners) await runPipeline(runner);
  await workersAiFallback();
  report();
}

function report(): void {
  console.table(results.map((r) => ({
    fixture: r.fixture, step: r.step, model: r.model, in: r.inputTokens, cached: r.cachedTokens,
    out: r.outputTokens, usd: r.costUsd.toFixed(5), ms: r.latencyMs, valid: r.valid,
  })));

  // Per model: average cost of brief + 8 variants, divided by 8 platforms.
  const byModel = new Map<string, StepResult[]>();
  for (const r of results) {
    if (r.step !== "brief" && r.step !== "variants_x8") continue;
    byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  }
  const perModel = [...byModel.entries()].map(([model, rs]) => {
    const perPost = rs.reduce((acc, r) => acc + r.costUsd, 0) / FIXTURES.length / PLATFORMS.length;
    return {
      model,
      costPerPlatformPostUsd: Number(perPost.toFixed(5)),
      withBatchDiscountUsd: model.startsWith("claude-") ? Number((perPost * BATCH_DISCOUNT).toFixed(5)) : null,
      validOutputs: `${rs.filter((r) => r.valid).length}/${rs.length}`,
      avgLatencyMs: Math.round(rs.reduce((acc, r) => acc + r.latencyMs, 0) / rs.length),
    };
  });
  console.table(perModel);

  const summary = {
    mode: DRY_RUN ? "dry-run (estimated)" : "measured",
    date: new Date().toISOString(),
    planningFigurePerPostUsd: 0.004,
    perModel,
    fallbackValid: results.filter((r) => r.provider === "workers-ai").every((r) => r.valid),
  };
  mkdirSync("out", { recursive: true });
  const file = `out/report-${summary.date.slice(0, 10)}${DRY_RUN ? "-dry" : ""}.json`;
  writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  console.log(`Report written to ${file}`);
}

main().catch((error: unknown) => {
  if (error instanceof Anthropic.APIError) console.error(`Claude API error ${error.status}: ${error.message}`);
  else console.error(error);
  process.exit(1);
});
