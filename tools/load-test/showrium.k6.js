// Showrium load test (k6). Run against PREVIEW, never production:
//   k6 run -e BASE_URL=https://preview.showrium.com -e API_KEY=shr_live_... tools/load-test/showrium.k6.js
// Optional: -e COMPOSE=1 adds a slow AI scenario (costs real AI credits, about $0.0001 per call).
//
// The API allows 120 requests a minute per IP, so from one machine you'll see 429s by design;
// they're counted separately and don't fail the run. What must hold: no 5xx, fast responses.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE_URL || "https://preview.showrium.com";
const KEY = __ENV.API_KEY;
const rateLimited = new Counter("rate_limited");
const serverErrors = new Counter("server_errors");

const scenarios = {
  public: { executor: "constant-arrival-rate", rate: 20, timeUnit: "1s", duration: "1m", preAllocatedVUs: 20, exec: "publicEndpoints" },
};
if (KEY) scenarios.reads = { executor: "constant-arrival-rate", rate: 5, timeUnit: "1s", duration: "1m", preAllocatedVUs: 10, exec: "authedReads", startTime: "5s" };
if (KEY && __ENV.COMPOSE === "1") scenarios.compose = { executor: "constant-arrival-rate", rate: 1, timeUnit: "10s", duration: "1m", preAllocatedVUs: 3, exec: "composePosts" };

export const options = {
  scenarios,
  thresholds: {
    server_errors: ["count==0"],
    "http_req_duration{expected_response:true}": ["p(95)<800"],
    "http_req_duration{scenario:compose,expected_response:true}": ["p(95)<20000"],
  },
};

function record(res, name) {
  if (res.status === 429) rateLimited.add(1);
  if (res.status >= 500) serverErrors.add(1, { name });
  check(res, { [`${name}: no server error`]: (r) => r.status < 500 });
}

export function publicEndpoints() {
  record(http.get(`${BASE}/api/health`, { tags: { name: "health" } }), "health");
  record(http.get(`${BASE}/api/v1/config`, { tags: { name: "config" } }), "config");
}

const auth = () => ({ headers: { Authorization: `Bearer ${KEY}` } });
export function authedReads() {
  for (const path of ["/me", "/drafts", "/ideas", "/analytics", "/usage"]) {
    record(http.get(`${BASE}/api/v1${path}`, { ...auth(), tags: { name: path } }), path);
  }
}

export function composePosts() {
  const ctx = http.post(`${BASE}/api/v1/contexts`, JSON.stringify({ kind: "manual", body: "Load test: we shipped a small fix to retries today." }), { headers: { ...auth().headers, "Content-Type": "application/json" }, tags: { name: "contexts" } });
  record(ctx, "contexts");
  if (ctx.status !== 201) return;
  const res = http.post(`${BASE}/api/v1/compose`, JSON.stringify({ contextItemId: ctx.json("id"), mode: "teach", platforms: ["bluesky"] }), { headers: { ...auth().headers, "Content-Type": "application/json" }, tags: { name: "compose" }, timeout: "60s" });
  record(res, "compose");
}
