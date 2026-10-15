# @nextrium/showrium-sdk

A typed TypeScript client for the Showrium API.

```ts
import { createShowriumClient } from "@nextrium/showrium-sdk";

const showrium = createShowriumClient({ apiKey: process.env.SHOWRIUM_API_KEY! });

const { data: ctx } = await showrium.POST("/contexts", { body: { kind: "manual", body: "We shipped retries with backoff." } });
const { data, error } = await showrium.POST("/compose", {
  body: { contextItemId: ctx!.id, mode: "build_in_public", platforms: ["linkedin", "bluesky"] },
});
```

- Types come from the OpenAPI document: `pnpm --filter @nextrium/showrium-sdk generate`
  (reads `OPENAPI_URL`, default `http://localhost:5173/api/v1/openapi.json`).
- AI agents can use the MCP server instead: `POST https://app.showrium.com/api/mcp` with the same API key.
