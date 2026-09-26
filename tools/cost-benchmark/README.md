# Cost benchmark

Runs sample contexts through Showrium's pipeline shape (a content brief, then 8 platform variants, plus a long-form article for expert takes). It reports the **measured** cost per post, and checks that every output matches its schema. If Cloudflare credentials are set, it also calls the Workers AI fallback model.

```bash
pnpm bench:dry
```

The dry run makes no API calls and estimates tokens from text length.

```bash
pnpm bench
```

The real run spends a few cents. Env vars:
- `ANTHROPIC_API_KEY`: required for the real run.
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`: optional; enable the Workers AI fallback test.
- `WORKERS_AI_MODEL`: optional; overrides the fallback model.

Reports are written to `out/`. That folder is git-ignored because it holds cost data; copy the findings into the internal docs.
