import { useState, type FormEvent } from "react";
import { api, formatDate, useApi } from "../../lib";

type Connection = { id: string; platform: string; handle: string; status: "active" | "needs_reconnect"; createdAt: string };
type List = { data: Connection[]; available: string[] };

const NAMES: Record<string, string> = { x: "X", linkedin: "LinkedIn", tiktok: "TikTok", bluesky: "Bluesky", mastodon: "Mastodon" };
const RESULT: Record<string, string> = {
  cancelled: "The connection was cancelled.",
  invalid_state: "That connection link expired or wasn't yours. Start again from this page.",
  forbidden: "Only workspace owners and admins can connect accounts.",
  not_configured: "That platform isn't set up in this environment yet.",
  connect_failed: "The platform didn't complete the connection. Try again.",
};

export function ConnectionsPage() {
  const { data, reload } = useApi<List>("/connections");
  const [error, setError] = useState<string | null>(null);
  const [notice] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", "/app/accounts");
    if (q.get("connected")) return `${NAMES[q.get("connected")!] ?? "Account"} connected.`;
    return q.get("error") ? RESULT[q.get("error")!] ?? "The connection didn't complete." : null;
  });

  const start = async (platform: string, body?: object) => {
    setError(null);
    try {
      const out = await api<{ authorizeUrl: string }>(`/connections/${platform}/start`, { method: "POST", body: JSON.stringify(body ?? {}) });
      window.location.assign(out.authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the connection.");
    }
  };
  const bluesky = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    try {
      await api("/connections/bluesky", { method: "POST", body: JSON.stringify({ identifier: String(f.get("identifier")), appPassword: String(f.get("appPassword")) }) });
      e.currentTarget.reset();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect Bluesky.");
    }
  };
  const disconnect = async (id: string) => {
    await api(`/connections/${id}`, { method: "DELETE" }).catch(() => undefined);
    reload();
  };

  const available = data?.available ?? [];
  return (
    <div className="dash">
      {notice && <p className="note" role="status">{notice}</p>}
      <section className="card">
        <h3>Connected accounts</h3>
        <p className="note">Showrium posts only what you approve. Tokens are encrypted and you can disconnect at any time.</p>
        <div className="table-wrap">
          <table>
            <tbody>
              {data?.data.map((c) => (
                <tr key={c.id}>
                  <td>{NAMES[c.platform] ?? c.platform}</td>
                  <td>{c.handle}</td>
                  <td className="muted">{c.status === "needs_reconnect" ? "Needs reconnecting" : `Connected ${formatDate(c.createdAt)}`}</td>
                  <td className="num"><button className="button danger" onClick={() => disconnect(c.id)}>Disconnect</button></td>
                </tr>
              ))}
              {data?.data.length === 0 && <tr><td className="muted">No accounts connected. You can still post with tap-to-post.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3>Connect an account</h3>
        {available.length === 0 && <p className="note">Connecting accounts isn't set up in this environment yet. Tap-to-post still works.</p>}
        <div className="row">
          {(["x", "linkedin", "tiktok"] as const).filter((p) => available.includes(p)).map((p) => (
            <button key={p} className="button secondary" onClick={() => start(p)}>Connect {NAMES[p]}</button>
          ))}
        </div>
        {available.includes("mastodon") && (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void start("mastodon", { instance: String(new FormData(e.currentTarget).get("instance")) }); }}>
            <label>Mastodon server<input id="mastodon-instance" name="instance" required placeholder="mastodon.social" /></label>
            <button className="button secondary">Connect Mastodon</button>
          </form>
        )}
        {available.includes("bluesky") && (
          <form className="row" onSubmit={bluesky}>
            <label>Bluesky handle<input id="bsky-id" name="identifier" required placeholder="you.bsky.social" autoComplete="off" /></label>
            <label>App password<input id="bsky-pw" name="appPassword" required placeholder="xxxx-xxxx-xxxx-xxxx" autoComplete="off" /></label>
            <button className="button secondary">Connect Bluesky</button>
          </form>
        )}
        {available.includes("bluesky") && (
          <p className="note">Create an app password in Bluesky: Settings → Privacy and security → App passwords. Never use your main password.</p>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
    </div>
  );
}
