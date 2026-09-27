import { useState } from "react";
import { api, useApi } from "../../lib";
import { PublishControls } from "./Publish";
import { IssueList, type Draft } from "./shared";

const LABELS: Record<string, string> = {
  linkedin: "LinkedIn", x: "X", instagram: "Instagram", facebook: "Facebook", threads: "Threads",
  bluesky: "Bluesky", mastodon: "Mastodon", tiktok: "TikTok", youtube_shorts: "YouTube Shorts",
};

export function DraftCard({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const [text, setText] = useState(draft.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const locked = draft.status === "published" || draft.status === "publishing";

  const patch = async (body: { text?: string; status?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ draft: Draft }>(`/drafts/${draft.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onChange(out.draft);
      setText(out.draft.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the post.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="card">
      <div className="dash-head">
        <h3>{LABELS[draft.platform] ?? draft.platform}</h3>
        <span className="chip">{draft.status}</span>
      </div>
      <textarea
        aria-label={`${LABELS[draft.platform]} post`}
        value={text}
        rows={Math.min(14, Math.max(4, Math.ceil(text.length / 70)))}
        onChange={(e) => setText(e.target.value)}
        disabled={locked}
      />
      <p className="note">{text.length} characters · AI-assisted draft</p>
      <IssueList issues={draft.issues} />
      {error && <p className="error" role="alert">{error}</p>}
      {!locked && (
        <div className="row">
          {text !== draft.text && <button className="button secondary" disabled={busy} onClick={() => patch({ text })}>Save edits</button>}
          {draft.status !== "approved" && draft.status !== "scheduled" && (
            <button className="button" disabled={busy || text !== draft.text} onClick={() => patch({ status: "approved" })}>Approve</button>
          )}
          {draft.status !== "discarded" ? (
            <button className="button danger" disabled={busy} onClick={() => patch({ status: "discarded" })}>Discard</button>
          ) : (
            <button className="button secondary" disabled={busy} onClick={() => patch({ status: "draft" })}>Restore</button>
          )}
          <button className="button secondary" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
      )}
      {(draft.status === "approved" || draft.status === "scheduled" || draft.status === "failed") && <PublishControls draft={draft} onChange={onChange} />}
      {draft.externalUrl && <p className="note"><a href={draft.externalUrl} target="_blank" rel="noreferrer">View the post</a></p>}
      {draft.lastError && <p className="error">{draft.lastError}</p>}
    </article>
  );
}

export function DraftsPage() {
  const [status, setStatus] = useState<string>("draft");
  const { data, reload } = useApi<{ data: Draft[] }>(`/drafts?status=${status}`);
  const [bulk, setBulk] = useState<string | null>(null);
  const ready = (data?.data ?? []).filter((d) => d.status === "draft" && d.issues.length === 0);

  // Batch approval: approves every draft without errors in one tap (at most 50 at a time).
  const approveAll = async () => {
    setBulk("Approving…");
    try {
      const out = await api<{ approved: string[]; skipped: { reason: string }[] }>("/drafts/bulk-approve", { method: "POST", body: JSON.stringify({ ids: ready.slice(0, 50).map((d) => d.id) }) });
      setBulk(`Approved ${out.approved.length}.${out.skipped.length ? ` Skipped ${out.skipped.length}: ${out.skipped[0]!.reason}` : ""}`);
      reload();
    } catch (err) {
      setBulk(err instanceof Error ? err.message : "Couldn't approve.");
    }
  };

  return (
    <div className="dash">
      <div className="tabs small caps">
        {["draft", "approved", "scheduled", "published", "failed", "discarded"].map((s) => (
          <button key={s} className={`tab${s === status ? " active" : ""}`} onClick={() => setStatus(s)}>{s}</button>
        ))}
      </div>
      {status === "draft" && ready.length > 1 && (
        <div className="row">
          <button className="button" disabled={bulk === "Approving…"} onClick={approveAll}>Approve all {Math.min(50, ready.length)} posts with no warnings</button>
          {bulk && <span className="note" role="status">{bulk}</span>}
        </div>
      )}
      {data?.data.length === 0 && <p className="note">Nothing here yet.</p>}
      {data?.data.map((d) => <DraftCard key={d.id} draft={d} onChange={() => reload()} />)}
    </div>
  );
}
