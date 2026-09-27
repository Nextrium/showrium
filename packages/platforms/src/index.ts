// Social platform adapters: OAuth, account lookup and text publishing.
// All network access goes through an injected `fetch` so tests can use fakes.
// Error messages are safe to show users; raw provider responses are never passed through.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | undefined;
  /** Epoch ms. */
  expiresAt?: number | undefined;
}
export interface Account {
  accountId: string;
  handle: string;
}
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
export interface PublishResult {
  externalId: string;
  url: string | null;
}

export class PlatformError extends Error {
  constructor(
    readonly platform: string,
    readonly kind: "auth" | "rate_limited" | "rejected" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

const TIMEOUT = 15_000;

async function request(platform: string, doFetch: FetchLike, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch {
    throw new PlatformError(platform, "unavailable", `${platform} didn't respond. Try again shortly.`);
  }
  if (res.status === 401 || res.status === 403) throw new PlatformError(platform, "auth", `${platform} refused the request. Reconnect the account and try again.`);
  if (res.status === 429) throw new PlatformError(platform, "rate_limited", `${platform} is rate-limiting requests. Try again later.`);
  if (res.status >= 500) throw new PlatformError(platform, "unavailable", `${platform} is having problems (HTTP ${res.status}). Try again shortly.`);
  if (!res.ok) throw new PlatformError(platform, "rejected", `${platform} rejected the post (HTTP ${res.status}).`);
  return res;
}

const form = (data: Record<string, string>) => new URLSearchParams(data).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const expiry = (seconds: unknown) => (typeof seconds === "number" ? Date.now() + seconds * 1000 : undefined);

// --- X (OAuth 2.0 with PKCE) ----------------------------------------------------------

export const x = {
  authorizeUrl(cfg: OAuthConfig, state: string, challenge: string) {
    const q = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: "tweet.read tweet.write users.read offline.access", state, code_challenge: challenge, code_challenge_method: "S256" });
    return `https://x.com/i/oauth2/authorize?${q}`;
  },
  async exchange(cfg: OAuthConfig, code: string, verifier: string, doFetch: FetchLike = fetch): Promise<TokenSet> {
    const res = await request("X", doFetch, "https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: { ...FORM, Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}` },
      body: form({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier, client_id: cfg.clientId }),
    });
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiry(t.expires_in) };
  },
  async refresh(cfg: OAuthConfig, refreshToken: string, doFetch: FetchLike = fetch): Promise<TokenSet> {
    const res = await request("X", doFetch, "https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: { ...FORM, Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}` },
      body: form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: cfg.clientId }),
    });
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: expiry(t.expires_in) };
  },
  async account(tokens: TokenSet, doFetch: FetchLike = fetch): Promise<Account> {
    const res = await request("X", doFetch, "https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    const { data } = (await res.json()) as { data: { id: string; username: string } };
    return { accountId: data.id, handle: `@${data.username}` };
  },
  async publish(tokens: TokenSet, account: Account, text: string, doFetch: FetchLike = fetch): Promise<PublishResult> {
    const res = await request("X", doFetch, "https://api.x.com/2/tweets", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const { data } = (await res.json()) as { data: { id: string } };
    return { externalId: data.id, url: `https://x.com/${account.handle.replace(/^@/, "")}/status/${data.id}` };
  },
};

// --- LinkedIn (OAuth 2.0; "Share on LinkedIn" + OpenID Connect) ---------------------------

/** LinkedIn's versioned API. Versions are retired after about a year: re-check before it lapses. */
export const LINKEDIN_VERSION = "202608";

/** LinkedIn "little text" format: these characters must be backslash-escaped in commentary. */
export function escapeLinkedIn(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

export const linkedin = {
  authorizeUrl(cfg: OAuthConfig, state: string) {
    const q = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri, state, scope: "openid profile w_member_social" });
    return `https://www.linkedin.com/oauth/v2/authorization?${q}`;
  },
  async exchange(cfg: OAuthConfig, code: string, _verifier: string, doFetch: FetchLike = fetch): Promise<TokenSet> {
    const res = await request("LinkedIn", doFetch, "https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: FORM,
      body: form({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    });
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiry(t.expires_in) };
  },
  async account(tokens: TokenSet, doFetch: FetchLike = fetch): Promise<Account> {
    const res = await request("LinkedIn", doFetch, "https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    const u = (await res.json()) as { sub: string; name?: string };
    return { accountId: u.sub, handle: u.name ?? "LinkedIn member" };
  },
  async publish(tokens: TokenSet, account: Account, text: string, doFetch: FetchLike = fetch): Promise<PublishResult> {
    const res = await request("LinkedIn", doFetch, "https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json", "LinkedIn-Version": LINKEDIN_VERSION, "X-Restli-Protocol-Version": "2.0.0" },
      body: JSON.stringify({
        author: `urn:li:person:${account.accountId}`,
        commentary: escapeLinkedIn(text),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });
    const urn = res.headers.get("x-restli-id") ?? "";
    return { externalId: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null };
  },
};

// --- TikTok (Login Kit; video publishing arrives with Phase 4) ------------------------------

export const tiktok = {
  authorizeUrl(cfg: OAuthConfig, state: string, challenge: string) {
    const q = new URLSearchParams({ client_key: cfg.clientId, scope: "user.info.basic,video.upload,video.publish", response_type: "code", redirect_uri: cfg.redirectUri, state, code_challenge: challenge, code_challenge_method: "S256" });
    return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
  },
  async exchange(cfg: OAuthConfig, code: string, verifier: string, doFetch: FetchLike = fetch): Promise<TokenSet> {
    const res = await request("TikTok", doFetch, "https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: FORM,
      body: form({ client_key: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: "authorization_code", redirect_uri: cfg.redirectUri, code_verifier: verifier }),
    });
    const t = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!t.access_token) throw new PlatformError("TikTok", "auth", "TikTok didn't grant access. Try connecting again.");
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: expiry(t.expires_in) };
  },
  async refresh(cfg: OAuthConfig, refreshToken: string, doFetch: FetchLike = fetch): Promise<TokenSet> {
    const res = await request("TikTok", doFetch, "https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: FORM,
      body: form({ client_key: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    const t = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? refreshToken, expiresAt: expiry(t.expires_in) };
  },
  async account(tokens: TokenSet, doFetch: FetchLike = fetch): Promise<Account> {
    const res = await request("TikTok", doFetch, "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name", { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    const { data } = (await res.json()) as { data: { user: { open_id: string; display_name?: string } } };
    return { accountId: data.user.open_id, handle: data.user.display_name ?? "TikTok user" };
  },
};

// --- Mastodon (per-instance OAuth with PKCE) --------------------------------------------------

export const MASTODON_SCOPES = "read:accounts write:statuses";
export const mastodon = {
  async registerApp(instance: string, redirectUri: string, doFetch: FetchLike = fetch): Promise<{ clientId: string; clientSecret: string }> {
    const res = await request("Mastodon", doFetch, `https://${instance}/api/v1/apps`, {
      method: "POST",
      headers: FORM,
      body: form({ client_name: "Showrium", redirect_uris: redirectUri, scopes: MASTODON_SCOPES, website: "https://showrium.com" }),
    });
    const app = (await res.json()) as { client_id: string; client_secret: string };
    return { clientId: app.client_id, clientSecret: app.client_secret };
  },
  authorizeUrl(instance: string, cfg: OAuthConfig, state: string, challenge: string) {
    const q = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: MASTODON_SCOPES, state, code_challenge: challenge, code_challenge_method: "S256" });
    return `https://${instance}/oauth/authorize?${q}`;
  },
  async exchange(instance: string, cfg: OAuthConfig, code: string, verifier: string, doFetch: FetchLike = fetch): Promise<TokenSet> {
    const res = await request("Mastodon", doFetch, `https://${instance}/oauth/token`, {
      method: "POST",
      headers: FORM,
      body: form({ grant_type: "authorization_code", code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, scope: MASTODON_SCOPES, code_verifier: verifier }),
    });
    const t = (await res.json()) as { access_token: string };
    return { accessToken: t.access_token };
  },
  async account(instance: string, tokens: TokenSet, doFetch: FetchLike = fetch): Promise<Account> {
    const res = await request("Mastodon", doFetch, `https://${instance}/api/v1/accounts/verify_credentials`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    const a = (await res.json()) as { id: string; acct: string };
    return { accountId: a.id, handle: `@${a.acct}@${instance}` };
  },
  async publish(instance: string, tokens: TokenSet, text: string, idempotencyKey: string, doFetch: FetchLike = fetch): Promise<PublishResult> {
    const res = await request("Mastodon", doFetch, `https://${instance}/api/v1/statuses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ status: text, visibility: "public" }),
    });
    const s = (await res.json()) as { id: string; url?: string };
    return { externalId: s.id, url: s.url ?? null };
  },
};

// --- Bluesky (app password; AT Protocol) -------------------------------------------------------

/** Link facets so URLs are clickable. Offsets are UTF-8 byte positions. */
export function blueskyLinkFacets(text: string) {
  const encoder = new TextEncoder();
  const facets: { index: { byteStart: number; byteEnd: number }; features: { $type: string; uri: string }[] }[] = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s)]+[^\s).,!?]/gi)) {
    const byteStart = encoder.encode(text.slice(0, m.index)).byteLength;
    facets.push({ index: { byteStart, byteEnd: byteStart + encoder.encode(m[0]).byteLength }, features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }] });
  }
  return facets;
}

export const bluesky = {
  async session(service: string, identifier: string, appPassword: string, doFetch: FetchLike = fetch) {
    const res = await request("Bluesky", doFetch, `${service}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password: appPassword }),
    });
    const s = (await res.json()) as { accessJwt: string; did: string; handle: string };
    return { accessJwt: s.accessJwt, account: { accountId: s.did, handle: `@${s.handle}` } };
  },
  async publish(service: string, accessJwt: string, account: Account, text: string, doFetch: FetchLike = fetch): Promise<PublishResult> {
    const facets = blueskyLinkFacets(text);
    const res = await request("Bluesky", doFetch, `${service}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: account.accountId,
        collection: "app.bsky.feed.post",
        record: { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), ...(facets.length ? { facets } : {}) },
      }),
    });
    const r = (await res.json()) as { uri: string };
    const rkey = r.uri.split("/").pop() ?? "";
    return { externalId: r.uri, url: `https://bsky.app/profile/${account.handle.replace(/^@/, "")}/post/${rkey}` };
  },
};

// --- Tap-to-post intents (free; the user posts from their own account) ---------------------------

export function intentUrl(platform: string, text: string, meta: { mastodonInstance?: string } = {}): string | null {
  const t = encodeURIComponent(text);
  switch (platform) {
    case "x":
      return `https://x.com/intent/post?text=${t}`;
    case "linkedin":
      return `https://www.linkedin.com/feed/?shareActive=true&text=${t}`;
    case "threads":
      return `https://www.threads.net/intent/post?text=${t}`;
    case "bluesky":
      return `https://bsky.app/intent/compose?text=${t}`;
    case "mastodon":
      return meta.mastodonInstance ? `https://${meta.mastodonInstance}/share?text=${t}` : null;
    default:
      return null; // Facebook, Instagram, TikTok, YouTube: copy the text and open the app.
  }
}
