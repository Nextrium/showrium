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
  /** X only: the account's subscription ("None", "Basic", "Premium", "PremiumPlus"). */
  subscription?: string | undefined;
}
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
export interface PublishResult {
  externalId: string;
  url: string | null;
  /** Bluesky: the record's content hash, needed to reply to it (threads). */
  cid?: string | undefined;
}
/** One image to attach (Sprint 6). Bytes are already checked; `alt` describes it for screen readers. */
export interface ImageUpload {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  alt: string;
  width?: number | undefined;
  height?: number | undefined;
}

function multipart(fields: Record<string, string | { bytes: Uint8Array<ArrayBuffer>; mime: string; name: string }>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string") form.set(k, v);
    else form.set(k, new Blob([v.bytes], { type: v.mime }), v.name);
  }
  return form;
}

/** For threads: the post to reply to, and the first post of the thread (Bluesky needs both). */
export interface ReplyTo {
  id: string;
  cid?: string | undefined;
  rootId?: string | undefined;
  rootCid?: string | undefined;
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
    const q = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri, scope: "tweet.read tweet.write users.read media.write offline.access", state, code_challenge: challenge, code_challenge_method: "S256" });
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
    // subscription_type tells us whether long posts (up to 25,000 characters) are allowed.
    const res = await request("X", doFetch, "https://api.x.com/2/users/me?user.fields=subscription_type", { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
    const { data } = (await res.json()) as { data: { id: string; username: string; subscription_type?: string } };
    const subscription = typeof data.subscription_type === "string" && /^[A-Za-z]{1,20}$/.test(data.subscription_type) ? data.subscription_type : "None";
    return { accountId: data.id, handle: `@${data.username}`, subscription };
  },
  /** Uploads an image (needs the media.write scope) and sets its alt text. Returns the media id. */
  async uploadImage(tokens: TokenSet, image: ImageUpload, doFetch: FetchLike = fetch): Promise<string> {
    const res = await request("X", doFetch, "https://api.x.com/2/media/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      body: multipart({ media: { bytes: image.bytes, mime: image.mime, name: "image" }, media_category: "tweet_image" }),
    });
    const { data } = (await res.json()) as { data: { id: string } };
    if (image.alt) {
      await request("X", doFetch, "https://api.x.com/2/media/metadata", {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: data.id, metadata: { alt_text: { text: image.alt.slice(0, 1000) } } }),
      }).catch(() => undefined); // alt text is best effort; the image still posts
    }
    return data.id;
  },
  async publish(tokens: TokenSet, account: Account, text: string, doFetch: FetchLike = fetch, replyTo?: ReplyTo, mediaId?: string): Promise<PublishResult> {
    const res = await request("X", doFetch, "https://api.x.com/2/tweets", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo.id } } : {}), ...(mediaId ? { media: { media_ids: [mediaId] } } : {}) }),
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
  /** Images API: ask for an upload URL, upload the bytes, and get the image URN for the post. */
  async uploadImage(tokens: TokenSet, account: Account, image: ImageUpload, doFetch: FetchLike = fetch): Promise<string> {
    const init = await request("LinkedIn", doFetch, "https://api.linkedin.com/rest/images?action=initializeUpload", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json", "LinkedIn-Version": LINKEDIN_VERSION, "X-Restli-Protocol-Version": "2.0.0" },
      body: JSON.stringify({ initializeUploadRequest: { owner: `urn:li:person:${account.accountId}` } }),
    });
    const { value } = (await init.json()) as { value: { uploadUrl: string; image: string } };
    if (!/^https:\/\/[a-z0-9.-]+\.linkedin\.com\//i.test(value.uploadUrl)) throw new PlatformError("LinkedIn", "rejected", "LinkedIn returned an unexpected upload address.");
    await request("LinkedIn", doFetch, value.uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": image.mime }, body: image.bytes });
    return value.image;
  },
  async publish(tokens: TokenSet, account: Account, text: string, doFetch: FetchLike = fetch, image?: { urn: string; alt: string }): Promise<PublishResult> {
    const res = await request("LinkedIn", doFetch, "https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json", "LinkedIn-Version": LINKEDIN_VERSION, "X-Restli-Protocol-Version": "2.0.0" },
      body: JSON.stringify({
        author: `urn:li:person:${account.accountId}`,
        commentary: escapeLinkedIn(text),
        ...(image ? { content: { media: { id: image.urn, altText: image.alt.slice(0, 4000) } } } : {}),
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

/** TikTok Content Posting API: send a video to the user's TikTok inbox as a draft (single chunk, up to 64 MB). */
export async function tiktokInboxUpload(tokens: TokenSet, video: BodyInit, size: number, contentType: string, doFetch: FetchLike = fetch): Promise<{ publishId: string }> {
  if (size < 1 || size > 64 * 1024 * 1024) throw new PlatformError("TikTok", "rejected", "Videos must be under 64 MB.");
  const init = await request("TikTok", doFetch, "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/", {
    method: "POST",
    headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 } }),
  });
  const out = (await init.json()) as { data?: { publish_id?: string; upload_url?: string }; error?: { code?: string } };
  if (!out.data?.upload_url || !out.data.publish_id || (out.error?.code && out.error.code !== "ok")) {
    throw new PlatformError("TikTok", "rejected", "TikTok didn't accept the upload. Check the account is connected with video permissions.");
  }
  await request("TikTok", doFetch, out.data.upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(size), "Content-Range": `bytes 0-${size - 1}/${size}` },
    body: video,
  });
  return { publishId: out.data.publish_id };
}

// --- Mastodon (per-instance OAuth with PKCE) --------------------------------------------------

export const MASTODON_SCOPES = "read:accounts write:statuses write:media";
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
  async uploadImage(instance: string, tokens: TokenSet, image: ImageUpload, doFetch: FetchLike = fetch): Promise<string> {
    const res = await request("Mastodon", doFetch, `https://${instance}/api/v2/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      body: multipart({ file: { bytes: image.bytes, mime: image.mime, name: "image" }, description: image.alt.slice(0, 1500) }),
    });
    return ((await res.json()) as { id: string }).id;
  },
  async publish(instance: string, tokens: TokenSet, text: string, idempotencyKey: string, doFetch: FetchLike = fetch, replyTo?: ReplyTo, mediaId?: string): Promise<PublishResult> {
    const res = await request("Mastodon", doFetch, `https://${instance}/api/v1/statuses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ status: text, visibility: "public", ...(replyTo ? { in_reply_to_id: replyTo.id } : {}), ...(mediaId ? { media_ids: [mediaId] } : {}) }),
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
  /** Bluesky takes images up to about 1 MB. */
  async uploadImage(service: string, accessJwt: string, image: ImageUpload, doFetch: FetchLike = fetch): Promise<unknown> {
    if (image.bytes.byteLength > 976_000) throw new PlatformError("Bluesky", "rejected", "Bluesky takes images up to 1 MB. Crop the image to its size in Showrium to make it smaller.");
    const res = await request("Bluesky", doFetch, `${service}/xrpc/com.atproto.repo.uploadBlob`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessJwt}`, "Content-Type": image.mime },
      body: image.bytes,
    });
    return ((await res.json()) as { blob: unknown }).blob;
  },
  async publish(service: string, accessJwt: string, account: Account, text: string, doFetch: FetchLike = fetch, replyTo?: ReplyTo, image?: { blob: unknown; alt: string; width?: number | undefined; height?: number | undefined }): Promise<PublishResult> {
    const facets = blueskyLinkFacets(text);
    const reply =
      replyTo?.cid && replyTo.rootId && replyTo.rootCid
        ? { reply: { root: { uri: replyTo.rootId, cid: replyTo.rootCid }, parent: { uri: replyTo.id, cid: replyTo.cid } } }
        : {};
    const res = await request("Bluesky", doFetch, `${service}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: account.accountId,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text,
          createdAt: new Date().toISOString(),
          ...(facets.length ? { facets } : {}),
          ...reply,
          ...(image
            ? { embed: { $type: "app.bsky.embed.images", images: [{ alt: image.alt.slice(0, 2000), image: image.blob, ...(image.width && image.height ? { aspectRatio: { width: image.width, height: image.height } } : {}) }] } }
            : {}),
        },
      }),
    });
    const r = (await res.json()) as { uri: string; cid?: string };
    const rkey = r.uri.split("/").pop() ?? "";
    return { externalId: r.uri, cid: r.cid, url: `https://bsky.app/profile/${account.handle.replace(/^@/, "")}/post/${rkey}` };
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

// --- Engagement readers (public, read-only endpoints; no tokens needed) ---------------------

export interface PostEngagement {
  likes: number;
  replies: number;
  reposts: number;
  /** Direct replies, newest first, at most 50. Text is plain (HTML removed). */
  comments: { externalId: string; author: string; text: string }[];
}

// Reply text is shown as plain text (React escapes it), never as HTML.
// Any leftover < or > is dropped, and &amp; is decoded last so "&amp;lt;" stays "&lt;".
const plain = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^<>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);

/** Bluesky: counts and direct replies from the public AppView. */
export async function blueskyEngagement(uri: string, doFetch: FetchLike = fetch): Promise<PostEngagement> {
  if (!/^at:\/\/did:[a-z0-9:._-]+\/app\.bsky\.feed\.post\/[a-z0-9]+$/i.test(uri)) throw new PlatformError("Bluesky", "rejected", "That isn't a Bluesky post address.");
  const q = new URLSearchParams({ uri, depth: "1", parentHeight: "0" });
  const res = await request("Bluesky", doFetch, `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?${q}`, {});
  type P = { uri: string; author?: { handle?: string }; record?: { text?: string }; likeCount?: number; replyCount?: number; repostCount?: number; quoteCount?: number };
  const data = (await res.json()) as { thread?: { post?: P; replies?: { post?: P }[] } };
  const post = data.thread?.post;
  const comments = (data.thread?.replies ?? [])
    .map((r) => r.post)
    .filter((p): p is P => Boolean(p?.uri && p.record?.text))
    .slice(0, 50)
    .map((p) => ({ externalId: p.uri, author: `@${p.author?.handle ?? "unknown"}`, text: String(p.record!.text).slice(0, 2000) }));
  return { likes: count(post?.likeCount), replies: count(post?.replyCount), reposts: count(post?.repostCount) + count(post?.quoteCount), comments };
}

/** Mastodon: counts and direct replies for a public status on the account's instance. */
export async function mastodonEngagement(instance: string, statusId: string, doFetch: FetchLike = fetch): Promise<PostEngagement> {
  if (!/^[a-z0-9.-]+$/i.test(instance) || !/^\d{1,30}$/.test(statusId)) throw new PlatformError("Mastodon", "rejected", "That isn't a Mastodon post address.");
  const base = `https://${instance}/api/v1/statuses/${statusId}`;
  const status = (await (await request("Mastodon", doFetch, base, {})).json()) as { favourites_count?: number; replies_count?: number; reblogs_count?: number };
  type S = { id: string; in_reply_to_id?: string | null; content?: string; account?: { acct?: string } };
  const context = (await (await request("Mastodon", doFetch, `${base}/context`, {})).json()) as { descendants?: S[] };
  const comments = (context.descendants ?? [])
    .filter((s) => s.in_reply_to_id === statusId && s.content)
    .slice(-50)
    .reverse()
    .map((s) => ({ externalId: `mastodon:${instance}:${s.id}`, author: `@${s.account?.acct ?? "unknown"}`, text: plain(s.content!).slice(0, 2000) }));
  return { likes: count(status.favourites_count), replies: count(status.replies_count), reposts: count(status.reblogs_count), comments };
}
