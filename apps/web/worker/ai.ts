// Builds the AI provider chain from configuration (ADR-0004, benchmark 2026-09-27):
// DeepSeek V4 Flash -> Gemini 3.1 Flash-Lite (both via OpenRouter) -> Workers AI (free).
import { fakeProvider, openRouterProvider, workersAiProvider, type Provider } from "@nextrium/llm";
import type { Env } from "./env.js";

/** The fake provider only ever runs on localhost (tests, local dev), never in a deployed environment. */
function fakeAllowed(env: Env): boolean {
  return env.LLM_MODE === "fake" && env.BETTER_AUTH_URL.startsWith("http://localhost");
}

function fakeReply(user: string): string {
  const repair = user.match(/^Rewrite this (\w+) post/);
  if (repair) return JSON.stringify({ text: "A shorter version that fits." });
  const ids = (user.match(/Platform ids: ([^.]+)\./)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return JSON.stringify({
    angle: "What changed and why it matters",
    key_points: ["The main change", "Why it helps"],
    variants: ids.map((platform) => ({
      platform,
      text: platform === "x" ? "Shipped a small improvement today. It makes retries safer." : `A ${platform} post about the change, in the user's voice.`,
    })),
  });
}

export function aiProviders(env: Env): Provider[] {
  if (fakeAllowed(env)) return [fakeProvider((req) => fakeReply(req.user))];
  const providers: Provider[] = [];
  if (env.OPENROUTER_API_KEY) {
    const common = { apiKey: env.OPENROUTER_API_KEY, appUrl: env.SITE_URL };
    providers.push(
      openRouterProvider({ ...common, model: "deepseek/deepseek-v4-flash", price: { input: 0.047, output: 0.094 } }),
      openRouterProvider({ ...common, model: "google/gemini-3.1-flash-lite", price: { input: 0.25, output: 1.5 } }),
    );
  }
  if (env.AI) providers.push(workersAiProvider({ ai: env.AI, model: "@cf/meta/llama-3.1-8b-instruct" }));
  return providers;
}
