# packages/llm

Prompts and the AI provider chain.

- Writing tries several providers in order (OpenRouter models, then Cloudflare Workers AI), so Showrium never depends on one.
- Web research lists the sources it used.
- `LLM_MODE=fake` gives fixed replies for local work and tests, with no AI key and no cost.
- Material from outside (feeds, links, web pages) is passed as data inside prompt tags, never as instructions.
