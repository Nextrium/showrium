// Builds the AI provider chain from configuration (ADR-0004, benchmark 2026-09-27):
// DeepSeek V4 Flash -> Gemini 3.1 Flash-Lite (both via OpenRouter) -> Workers AI (free).
import { fakeProvider, fakeResearchProvider, openRouterProvider, openRouterResearchProvider, workersAiProvider, type Provider, type ResearchProvider } from "@nextrium/llm";
import type { Env } from "./env.js";

/** The fake provider only ever runs on localhost (tests, local dev), never in a deployed environment. */
function fakeAllowed(env: Env): boolean {
  return env.LLM_MODE === "fake" && env.BETTER_AUTH_URL.startsWith("http://localhost");
}

const FAKE_TIMELINE = {
  title: "Retries that don't hammer your system",
  narration: "I shipped retries with backoff today. Here is what changed and why it matters for anyone running background jobs.",
  aspect: "9:16",
  scenes: [
    { kind: "title", heading: "Safer retries", body: "queue-lite v1.4.0", durationMs: 5000 },
    { kind: "bullets", heading: "What changed", lines: ["Exponential backoff", "Jitter", "Dead-letter queue"], durationMs: 8000 },
    { kind: "code", heading: "The idea", code: "delay = base * 2 ** attempt\ndelay += random(0, jitter)", durationMs: 8000 },
    { kind: "outro", heading: "Try it", body: "Link in my profile", durationMs: 5000 },
  ],
};

function fakeReply(user: string): string {
  if (user.startsWith("Group these")) {
    return JSON.stringify({ themes: [{ label: "How retries work", kind: "question", count: 3, examples: ["How is the delay chosen?"], suggestion: "Explain how the retry delay grows and why jitter helps." }] });
  }
  if (user.startsWith("Plan a ") || user.startsWith("Revise this video plan")) {
    const aspect = user.match(/Plan a (9:16|1:1|16:9)/)?.[1] ?? "9:16";
    const title = user.includes("shorter title") ? "Shorter" : FAKE_TIMELINE.title;
    return JSON.stringify({ ...FAKE_TIMELINE, aspect, title });
  }
  const repair = user.match(/^Rewrite this (\w+) post/);
  if (repair) return JSON.stringify({ text: "A shorter version that fits." });
  const ids = (user.match(/Platform ids: ([^.]+)\./)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const threaded = (user.match(/For ([a-z_, ]+): write a thread\./)?.[1] ?? "").split(",").map((s) => s.trim());
  const parts = ["Retries used to fail silently. Here's what we changed.", "Each retry now waits a little longer than the last.", "A small random delay stops every client retrying at once."];
  return JSON.stringify({
    ...(user.includes("choose the best one for the request") ? { mode: "expert_take" } : {}),
    angle: "What changed and why it matters",
    key_points: ["The main change", "Why it helps"],
    variants: ids.map((platform) =>
      threaded.includes(platform)
        ? { platform, text: parts.join("\n\n"), parts }
        : { platform, text: platform === "x" ? "Shipped a small improvement today. It makes retries safer." : `A ${platform} post about the change, in the user's voice.` },
    ),
  });
}

export function aiProviders(env: Env): Provider[] {
  if (fakeAllowed(env)) return [fakeProvider((req) => fakeReply(req.user))];
  const providers: Provider[] = [];
  if (env.OPENROUTER_API_KEY) {
    const common = { apiKey: env.OPENROUTER_API_KEY, appUrl: env.SITE_URL };
    providers.push(
      // OpenRouter list prices per million tokens, checked 2026-10-08.
      openRouterProvider({ ...common, model: "deepseek/deepseek-v4-flash", price: { input: 0.0131, output: 1.28 } }),
      openRouterProvider({ ...common, model: "google/gemini-3.1-flash-lite", price: { input: 0.25, output: 1.5 } }),
    );
  }
  if (env.AI) providers.push(workersAiProvider({ ai: env.AI, model: "@cf/meta/llama-3.1-8b-instruct" }));
  return providers;
}

/**
 * Web research (benchmark 2026-10-08 on a real request: DeepSeek V4 Pro with Exa search found the
 * most, every link checked; Perplexity Sonar is the fallback, with a different search engine).
 */
export function researchProviders(env: Env): ResearchProvider[] {
  if (fakeAllowed(env)) return [fakeResearchProvider((req) => fakeResearch(req.user))];
  if (!env.OPENROUTER_API_KEY) return [];
  const common = { apiKey: env.OPENROUTER_API_KEY, appUrl: env.SITE_URL };
  return [
    openRouterResearchProvider({ ...common, model: "deepseek/deepseek-v4-pro", extra: { reasoning: { enabled: false }, plugins: [{ id: "web", engine: "exa", max_results: 8 }] } }),
    openRouterResearchProvider({ ...common, model: "perplexity/sonar", extra: { web_search_options: { search_context_size: "medium" } } }),
  ];
}

/** Deterministic research for tests: one real-looking finding, and one with a link the search never returned. */
function fakeResearch(user: string) {
  const citations = [
    { url: "https://news.example/lagos-life", title: "Lagos Life goes viral" },
    { url: "https://news.example/offer", title: "Creator turns down offer" },
  ];
  if (user.includes("NOTHING-FOUND")) return { text: JSON.stringify({ subject: "", summary: "", facts: [], found_enough: false }), citations, costMicroUsd: 7000 };
  return {
    text: JSON.stringify({
      subject: "Lagos Life",
      summary: "A browser game by a UK-based Nigerian developer that went viral.",
      facts: [
        { claim: "Lagos Life passed 1 million players.", source: "https://news.example/lagos-life" },
        { claim: "A made-up claim.", source: "https://invented.example/nope" },
      ],
      criticism: [{ point: "Some called the $1B valuation unrealistic.", source: "https://news.example/offer" }],
      support: [],
      hints: [
        { hint: "She turned down a $100K offer.", status: "confirmed", source: "https://www.news.example/offer/" },
        { hint: "Two live database migrations.", status: "confirmed", source: "https://invented.example/db" },
      ],
      found_enough: true,
    }),
    citations,
    costMicroUsd: 15000,
  };
}
