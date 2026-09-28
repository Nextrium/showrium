import { useState } from "react";
import { api, useApi } from "../../lib";
import { PublishControls } from "./Publish";
import { IssueList, type Draft } from "./shared";
import { Button, Empty, Icon, LinkButton, PageHeader, Panel } from "../../ui/kit";

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

const TABS = [
  ["draft", "Drafts"],
  ["approved", "Approved"],
  ["scheduled", "Scheduled"],
  ["published", "Published"],
  ["failed", "Failed"],
  ["discarded", "Discarded"],
] as const;

export function DraftsPage() {
  const [status, setStatus] = useState<string>("draft");
  const { data, reload } = useApi<{ data: Draft[] }>(`/drafts?status=${status}`);
  const { data: counts } = useApi<{ statuses: Record<string, number> }>("/analytics");
  const [bulk, setBulk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const drafts = status === "draft" ? data?.data ?? [] : [];
  const ready = drafts.filter((d) => d.issues.length === 0);
  const toCheck = drafts.length - ready.length;

  // Batch approval: approves every draft with no warnings in one tap (at most 50 at a time).
  const approveAll = async () => {
    setBusy(true);
    setBulk(null);
    try {
      const out = await api<{ approved: string[]; skipped: { reason: string }[] }>("/drafts/bulk-approve", { method: "POST", body: JSON.stringify({ ids: ready.slice(0, 50).map((d) => d.id) }) });
      setBulk(`Approved ${out.approved.length}.${out.skipped.length ? ` Skipped ${out.skipped.length}: ${out.skipped[0]!.reason}` : ""}`);
      reload();
    } catch (err) {
      setBulk(err instanceof Error ? err.message : "Couldn't approve.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dash">
      <PageHeader title="Posts" subtitle="Everything you’ve written: waiting, scheduled, or out in the world." actions={<LinkButton to="/app/new" variant="inverse" icon="plus">New post</LinkButton>} />
      <div className="tabs" role="tablist" aria-label="Post status">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={id === status} className="tab" onClick={() => setStatus(id)}>
            {label}
            {counts && <span className="ml-2 rounded-full bg-raised px-2 font-mono text-[11.5px] text-ink-2">{counts.statuses[id] ?? 0}</span>}
          </button>
        ))}
      </div>
      {status === "draft" && drafts.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line-strong bg-raised px-4 py-3.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ok-soft text-ok"><Icon name="check" strokeWidth={2.2} /></span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="font-semibold">{ready.length} of {drafts.length} draft{drafts.length === 1 ? " is" : "s are"} ready to approve</span>
            <span className="text-[13.5px] text-muted">{toCheck ? `${toCheck} ${toCheck === 1 ? "has" : "have"} something to check first, so ${toCheck === 1 ? "it’s" : "they’re"} left out of one-tap approval.` : "None have warnings."}</span>
          </div>
          {ready.length > 0 && <Button disabled={busy} onClick={approveAll}>{busy ? "Approving…" : `Approve ${Math.min(50, ready.length)}`}</Button>}
        </div>
      )}
      {bulk && <p className="note" role="status">{bulk}</p>}
      {data?.data.length === 0 && (
        <Panel>
          <Empty
            icon="posts"
            title={`No ${TABS.find(([id]) => id === status)![1].toLowerCase()} posts`}
            body={status === "draft" ? "Write something new, or turn an idea into posts." : "Posts move here as you approve, schedule and publish them."}
            action={status === "draft" ? <LinkButton to="/app/new" size="sm">New post</LinkButton> : undefined}
          />
        </Panel>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {data?.data.map((d) => <DraftCard key={d.id} draft={d} onChange={() => reload()} />)}
      </div>
    </div>
  );
}
