import { useState } from "react";
import { api, useApi } from "../../lib";
import type { Draft } from "./shared";

type Connection = { id: string; platform: string; handle: string; status: string };
const API_PLATFORMS = ["x", "linkedin", "bluesky", "mastodon"];
const OPEN_APP: Record<string, string> = {
  facebook: "https://www.facebook.com/",
  instagram: "https://www.instagram.com/",
  tiktok: "https://www.tiktok.com/upload",
  youtube_shorts: "https://studio.youtube.com/",
};

export function PublishControls({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const { data } = useApi<{ data: Connection[] }>("/connections");
  // Loaded ahead of time so "Post it myself" is a plain link: opening a tab after an await
  // is treated as an unrequested popup and blocked by browsers.
  const { data: intent } = useApi<{ url: string | null }>(`/drafts/${draft.id}/intent`, { live: false });
  const postUrl = intent ? intent.url ?? OPEN_APP[draft.platform] ?? null : null;
  const accounts = (data?.data ?? []).filter((c) => c.platform === draft.platform && c.status === "active");
  const [connectionId, setConnectionId] = useState<string>("");
  const [when, setWhen] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const chosen = connectionId || accounts[0]?.id || "";

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const publishNow = () =>
    act(async () => {
      const out = await api<{ url: string | null }>(`/drafts/${draft.id}/publish`, { method: "POST", body: JSON.stringify({ connectionId: chosen }) });
      onChange({ ...draft, status: "published", externalUrl: out.url });
    });
  const schedule = () =>
    act(async () => {
      await api(`/drafts/${draft.id}/schedule`, { method: "POST", body: JSON.stringify({ connectionId: chosen, at: new Date(when).toISOString() }) });
      setMessage(`Scheduled for ${new Date(when).toLocaleString()}.`);
      onChange({ ...draft, status: "scheduled", scheduledAt: new Date(when).toISOString() });
    });
  const tapToPost = () => {
    // Runs synchronously inside the click, alongside the link opening in a new tab.
    navigator.clipboard.writeText(draft.text).catch(() => undefined);
    setOpened(true);
    setMessage(intent?.url ? "Opened with your post filled in. Post it there, then mark it as posted." : "Your post is copied. Paste it in the app, then mark it as posted.");
  };
  const markPosted = () =>
    act(async () => {
      await api(`/drafts/${draft.id}/mark-published`, { method: "POST", body: JSON.stringify({ url: null }) });
      onChange({ ...draft, status: "published" });
    });

  const canApi = API_PLATFORMS.includes(draft.platform) && accounts.length > 0;
  return (
    <div className="form">
      <div className="row">
        {postUrl ? (
          <a className="button" href={postUrl} target="_blank" rel="noopener noreferrer" onClick={tapToPost}>Post it myself (free)</a>
        ) : (
          <button className="button" onClick={tapToPost}>Copy for posting (free)</button>
        )}
        {opened && <button className="button secondary" disabled={busy} onClick={markPosted}>I've posted it</button>}
      </div>
      {canApi && (
        <div className="row">
          {accounts.length > 1 && (
            <label>
              Account
              <select value={chosen} onChange={(e) => setConnectionId(e.target.value)}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.handle}</option>)}
              </select>
            </label>
          )}
          <button className="button secondary" disabled={busy} onClick={publishNow}>
            Publish now{draft.platform === "x" ? " (uses X credits)" : ""}
          </button>
          <label>
            Or schedule
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
          <button className="button secondary" disabled={busy || !when} onClick={schedule}>Schedule</button>
        </div>
      )}
      {message && <p className="note" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
