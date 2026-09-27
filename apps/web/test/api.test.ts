import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://localhost:5173";
const ORIGIN = { Origin: BASE };

async function signUp(email: string, name: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ORIGIN },
    body: JSON.stringify({ email, name, password: "correct-horse-battery" }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(cookie).toContain("session_token");
  return cookie;
}

async function createKey(cookie: string, name = "CI key") {
  const res = await SELF.fetch(`${BASE}/api/v1/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, ...ORIGIN },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; key: string; prefix: string };
}

describe("public endpoints", () => {
  it("reports health", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("serves the OpenAPI document", async () => {
    const doc = (await (await SELF.fetch(`${BASE}/api/v1/openapi.json`)).json()) as { openapi: string; paths: object };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/api-keys");
  });

  it("serves a readable API reference page", async () => {
    const res = await SELF.fetch(`${BASE}/api/docs`);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("/api/v1/openapi.json");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/nope`);
    expect(res.status).toBe(404);
  });
});

describe("accounts and workspaces", () => {
  it("rejects anonymous calls", async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/me`);
    expect(res.status).toBe(401);
  });

  it("gives a new user a workspace, owner role and welcome credits", async () => {
    const cookie = await signUp("ada@example.com", "Ada Lovelace");
    const me = (await (await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: cookie } })).json()) as {
      principal: { role: string };
      workspace: { name: string; plan: string };
    };
    expect(me.principal.role).toBe("owner");
    expect(me.workspace.name).toBe("Ada's workspace");
    expect(me.workspace.plan).toBe("free");

    const credits = (await (await SELF.fetch(`${BASE}/api/v1/credits`, { headers: { Cookie: cookie } })).json()) as {
      balance: number;
      transactions: { kind: string }[];
    };
    expect(credits.balance).toBe(20);
    expect(credits.transactions[0]?.kind).toBe("grant");
  });
});

describe("API keys", () => {
  it("creates a key that authenticates, cannot mint keys, and stops working when revoked", async () => {
    const cookie = await signUp("kemi@example.com", "Kemi Dev");
    const created = await createKey(cookie);
    expect(created.key).toMatch(/^shr_live_/);

    const bearer = { Authorization: `Bearer ${created.key}` };
    const credits = await SELF.fetch(`${BASE}/api/v1/credits`, { headers: bearer });
    expect(credits.status).toBe(200);

    const mint = await SELF.fetch(`${BASE}/api/v1/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer },
      body: JSON.stringify({ name: "escalation" }),
    });
    expect(mint.status).toBe(403);

    const list = (await (await SELF.fetch(`${BASE}/api/v1/api-keys`, { headers: { Cookie: cookie } })).json()) as {
      data: { id: string; prefix: string }[];
    };
    expect(list.data.map((k) => k.id)).toContain(created.id);
    expect(JSON.stringify(list)).not.toContain(created.key);

    const revoke = await SELF.fetch(`${BASE}/api/v1/api-keys/${created.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, ...ORIGIN },
    });
    expect(revoke.status).toBe(204);
    const after = await SELF.fetch(`${BASE}/api/v1/credits`, { headers: bearer });
    expect(after.status).toBe(401);
  });

  it("blocks cookie-authenticated writes from other sites", async () => {
    const cookie = await signUp("tunde@example.com", "Tunde");
    const res = await SELF.fetch(`${BASE}/api/v1/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "https://evil.example" },
      body: JSON.stringify({ name: "csrf" }),
    });
    expect(res.status).toBe(403);
  });

  it("keeps workspaces isolated", async () => {
    const alice = await signUp("alice@example.com", "Alice");
    const bob = await signUp("bob@example.com", "Bob");
    const aliceKey = await createKey(alice, "alice key");

    const bobRevoke = await SELF.fetch(`${BASE}/api/v1/api-keys/${aliceKey.id}`, {
      method: "DELETE",
      headers: { Cookie: bob, ...ORIGIN },
    });
    expect(bobRevoke.status).toBe(404);

    const bobKeys = (await (await SELF.fetch(`${BASE}/api/v1/api-keys`, { headers: { Cookie: bob } })).json()) as {
      data: unknown[];
    };
    expect(bobKeys.data).toHaveLength(0);

    const aliceMe = (await (await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: alice } })).json()) as {
      workspace: { id: string };
    };
    const bobAsAlice = await SELF.fetch(`${BASE}/api/v1/me`, { headers: { Cookie: bob, "X-Org-Id": aliceMe.workspace.id } });
    expect(bobAsAlice.status).toBe(403);
  });
});
