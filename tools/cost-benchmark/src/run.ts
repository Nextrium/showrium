// Cost benchmark: runs sample contexts through the real pipeline shape
// (brief -> platform variants) and reports measured cost per post.
//
//   pnpm --filter @nextrium/showrium-cost-benchmark bench:dry   # no API calls, token estimates only
//   pnpm --filter @nextrium/showrium-cost-benchmark bench       # real calls (spends a few cents)
//
// Env: ANTHROPIC_API_KEY (Claude), CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Workers AI fallback, optional).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { FIXTURES, PERSONA, PLATFORMS, type Fixture } from "./fixtures.js";
import { BATCH_DISCOUNT, claudeCost, type Usage } from "./prices.js";

const DRY_RUN = process.argv.includes("--dry-run");
const PRIMARY = "claude-haiku-4-5";
const LONGFORM = "claude-sonnet-5";
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

interface StepResult {
  fixture: string;
  step: string;
  model: string;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  valid: boolean;
}

const results: StepResult[] = [];

function estimateUsage(inputChars: number, outputTokens: number): Usage {
  return { input_tokens: Math.ceil(inputChars / 4), output_tokens: outputTokens };
}

async function claudeStep<T extends z.ZodType>(
  client: Anthropic,
  fixture: Fixture,
  step: string,
  model: string,
  userContent: string,
  schema: T,
  maxTokens: number,
): Promise<z.infer<T> | null> {
  if (DRY_RUN) {
    const usage = estimateUsage(SYSTEM.length + userContent.length, maxTokens / 2);
    results.push({ fixture: fixture.id, step, model, usage, costUsd: claudeCost(model, usage), latencyMs: 0, valid: true });
    return null;
  }
  const started = Date.now();
  const response = await client.messages.parse({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(schema) },
  });
  const usage: Usage = response.usage;
  results.push({
    fixture: fixture.id,
    step,
    model,
    usage,
    costUsd: claudeCost(model, usage),
    latencyMs: Date.now() - started,
    valid: response.parsed_output !== null,
  });
  return response.parsed_output;
}

async function workersAiFallback(fixture: Fixture): Promise<void> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (DRY_RUN || !account || !token) return;
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
  results.push({
    fixture: fixture.id,
    step: "fallback_linkedin_post",
    model: WORKERS_AI_MODEL,
    usage: { input_tokens: 0, output_tokens: 0 },
    costUsd: 0, // Within the 10k free neurons/day; check the Workers AI dashboard for neuron usage.
    latencyMs: Date.now() - started,
    valid: res.ok && body.success === true && (body.result?.response?.length ?? 0) > 50,
  });
}

async function main(): Promise<void> {
  if (!DRY_RUN && !process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Use --dry-run for estimates without API calls.");
    process.exit(1);
  }
  const client = new Anthropic();

  for (const fixture of FIXTURES) {
    const brief = await claudeStep(
      client, fixture, "brief", PRIMARY,
      `Mode: ${fixture.mode}\nContext:\n${fixture.context}\n\nWrite a content brief.`,
      BriefSchema, 1024,
    );
    await claudeStep(
      client, fixture, "variants_x8", PRIMARY,
      `Mode: ${fixture.mode}\nContext:\n${fixture.context}\n\nBrief:\n${JSON.stringify(brief ?? {})}\n\n` +
        `Write one post for each platform: ${PLATFORMS.join(", ")}.`,
      VariantsSchema, 4096,
    );
    if (fixture.mode === "expert_take") {
      await claudeStep(
        client, fixture, "longform_article", LONGFORM,
        `Context:\n${fixture.context}\n\nWrite a 600-800 word Dev.to article in the user's voice.`,
        z.object({ title: z.string(), body_markdown: z.string() }), 4096,
      );
    }
    await workersAiFallback(fixture);
  }

  report();
}

function report(): void {
  const claude = results.filter((r) => r.model.startsWith("claude-"));
  const variantSteps = claude.filter((r) => r.step === "variants_x8");
  const briefSteps = claude.filter((r) => r.step === "brief");
  const sum = (rs: StepResult[]) => rs.reduce((acc, r) => acc + r.costUsd, 0);
  const avgSet = (sum(briefSteps) + sum(variantSteps)) / Math.max(1, FIXTURES.length);
  const perPost = avgSet / PLATFORMS.length;
  const cacheReads = claude.reduce((acc, r) => acc + (r.usage.cache_read_input_tokens ?? 0), 0);

  console.table(
    results.map((r) => ({
      fixture: r.fixture,
      step: r.step,
      model: r.model,
      in: r.usage.input_tokens,
      cacheRead: r.usage.cache_read_input_tokens ?? 0,
      out: r.usage.output_tokens,
      usd: r.costUsd.toFixed(5),
      ms: r.latencyMs,
      valid: r.valid,
    })),
  );
  const summary = {
    mode: DRY_RUN ? "dry-run (estimated)" : "measured",
    date: new Date().toISOString(),
    avgCostPerSetUsd: Number(avgSet.toFixed(5)),
    avgCostPerPlatformPostUsd: Number(perPost.toFixed(5)),
    withBatchDiscountPerPostUsd: Number((perPost * BATCH_DISCOUNT).toFixed(5)),
    planningFigurePerPostUsd: 0.004,
    cacheReadTokens: cacheReads,
    allOutputsValid: results.every((r) => r.valid),
  };
  console.log(summary);
  mkdirSync("out", { recursive: true });
  const file = `out/report-${summary.date.slice(0, 10)}${DRY_RUN ? "-dry" : ""}.json`;
  writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
  console.log(`Report written to ${file}`);
}

main().catch((error: unknown) => {
  if (error instanceof Anthropic.APIError) {
    console.error(`Claude API error ${error.status}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
