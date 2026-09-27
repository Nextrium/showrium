// Server-side fetch of user-supplied URLs (links, feeds) with SSRF protection:
// http(s) only, default ports only, no IP literals or internal hostnames, redirects
// re-validated at every hop, response size and time capped.

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".arpa"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data"]);

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("That isn't a valid web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("Only http and https links are supported.");
  if (url.username || url.password) throw new UnsafeUrlError("Links with embedded credentials aren't allowed.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UnsafeUrlError("Links on non-standard ports aren't allowed.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // Any IP literal (v4, v6, or numeric forms like 2130706433) is refused: use a hostname.
  if (host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || host.includes(":")) {
    throw new UnsafeUrlError("Links to IP addresses aren't allowed. Use the site's name.");
  }
  if (!host.includes(".") || BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("That address isn't reachable from Showrium.");
  }
  return url;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function safeFetchText(
  raw: string,
  opts: { fetch?: FetchLike | undefined; maxBytes?: number; timeoutMs?: number; accept?: string; allowedTypes?: RegExp } = {},
): Promise<{ url: string; contentType: string; text: string }> {
  const doFetch = opts.fetch ?? fetch;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  let url = assertSafeUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const res = await doFetch(url.toString(), {
      redirect: "manual",
      headers: { "User-Agent": "ShowriumBot/1.0 (+https://showrium.com)", Accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location");
      if (!location) throw new UnsafeUrlError("The link redirected without a destination.");
      url = assertSafeUrl(new URL(location, url).toString());
      continue;
    }
    if (!res.ok) throw new Error(`The site answered with HTTP ${res.status}.`);
    const contentType = (res.headers.get("Content-Type") ?? "").toLowerCase();
    if (opts.allowedTypes && !opts.allowedTypes.test(contentType)) throw new Error(`Unsupported content type: ${contentType || "unknown"}.`);
    const declared = Number(res.headers.get("Content-Length") ?? "0");
    if (declared > maxBytes) throw new Error("The page is too large.");
    const reader = res.body?.getReader();
    if (!reader) return { url: url.toString(), contentType, text: "" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("The page is too large.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { url: url.toString(), contentType, text: new TextDecoder().decode(bytes) };
  }
  throw new UnsafeUrlError("Too many redirects.");
}
