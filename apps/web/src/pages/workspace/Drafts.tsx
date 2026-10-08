import { useEffect, useMemo, useState } from "react";
import { ResearchNotes } from "../../components/ResearchNotes";
import { api, formatDate, setUnsaved, timeAgo, useApi } from "../../lib";
import { PublishControls } from "./Publish";
import { IssueList, MODES, usePlatforms, type Draft } from "./shared";
import { Alert, Button, Empty, Icon, LinkButton, Loading, PageHeader, type IconName } from "../../ui/kit";
import { PostImagePanel } from "../../components/PostImage";
import { DetailPanel, ListItem, SectionLabel, Split, StatStrip, Tag, useQueryParams } from "../../ui/split";

export const PLATFORM_LABELS: Record<string, string> = {
  linkedin: "LinkedIn", x: "X", instagram: "Instagram", facebook: "Facebook", threads: "Threads",
  bluesky: "Bluesky", mastodon: "Mastodon", tiktok: "TikTok", youtube_shorts: "YouTube Shorts",
};

/** What a post was written from, in plain words. */
export const SOURCE_KINDS: Record<string, { label: string; icon: IconName }> = {
  manual: { label: "Your note", icon: "edit" },
  url: { label: "A link", icon: "link" },
  github_release: { label: "GitHub release", icon: "git" },
  github_activity: { label: "GitHub commits", icon: "git" },
  rss_item: { label: "Article or video", icon: "sources" },
  voice: { label: "Voice note", icon: "voice" },
  photo: { label: "Your photo", icon: "photo" },
  document: { label: "Your document", icon: "doc" },
  prompt: { label: "Daily question", icon: "comment" },
  request: { label: "Your request to the AI", icon: "ideas" },
};

const STATUSES = [
  { id: "draft", label: "Drafts", tone: "accent" },
  { id: "approved", label: "Approved", tone: "info" },
  { id: "scheduled", label: "Scheduled", tone: "warn" },
  { id: "published", label: "Published", tone: "ok" },
  { id: "failed", label: "Failed", tone: "danger" },
  { id: "discarded", label: "Discarded", tone: "neutral" },
] as const;
const statusTone = (s: string) => STATUSES.find((x) => x.id === s)?.tone ?? "neutral";
const modeLabel = (m: string | undefined) => MODES.find((x) => x.id === m)?.label ?? null;
const sourceTitle = (d: Draft) => d.source?.title || (d.source?.kind ? SOURCE_KINDS[d.source.kind]?.label : null) || "Written by you";

function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const m = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

/** A post as a card (used on New post, right after writing). */
export function DraftCard({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  return (
    <div className="rounded-[18px] border border-line bg-panel p-5">
      <PostEditor draft={draft} onChange={onChange} />
    </div>
  );
}

/** Platforms where a post can be a thread (a chain of replies). */
export const THREAD_PLATFORMS = ["x", "bluesky", "threads", "mastodon"];

/** Splits one post into thread parts: by paragraph, then by sentence when a paragraph is too long. */
export function splitIntoParts(text: string, limit: number): string[] {
  const parts: string[] = [];
  for (const para of text.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= limit) {
      parts.push(para);
      continue;
    }
    let cur = "";
    for (const sentence of para.match(/[^.!?]+[.!?]*/g) ?? [para]) {
      if (cur && (cur + sentence).trim().length > limit) {
        parts.push(cur.trim());
        cur = "";
      }
      cur += sentence;
    }
    if (cur.trim()) parts.push(cur.trim());
  }
  return parts.length ? parts : [text];
}

/** Edit, approve, discard, copy and publish one post or thread. */
function PostEditor({ draft, onChange }: { draft: Draft; onChange?: (d: Draft) => void }) {
  const platforms = usePlatforms();
  const { data: conns } = useApi<{ data: { platform: string; status: string; longPosts: boolean }[] }>("/connections");
  const xLong = draft.platform === "x" && Boolean(conns?.data.some((c) => c.platform === "x" && c.status === "active" && c.longPosts));
  const partLimit = platforms.find((p) => p.id === draft.platform)?.maxLength;
  const limit = xLong ? 25_000 : partLimit;
  const [text, setText] = useState(draft.text);
  const [parts, setParts] = useState<string[] | null>(draft.parts && draft.parts.length > 1 ? draft.parts : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const locked = draft.status === "published" || draft.status === "publishing";
  const serverParts = draft.parts && draft.parts.length > 1 ? draft.parts : null;
  const dirty = parts ? JSON.stringify(parts) !== JSON.stringify(serverParts) : serverParts !== null || text !== draft.text;
  const threadable = THREAD_PLATFORMS.includes(draft.platform);
  const label = PLATFORM_LABELS[draft.platform] ?? draft.platform;

  // A fresh copy from the server (after an action elsewhere) replaces the text unless it's being edited.
  useEffect(() => {
    if (!dirty) {
      setText(draft.text);
      setParts(serverParts);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.text, JSON.stringify(draft.parts)]);
  useEffect(() => {
    setUnsaved(`post:${draft.id}`, dirty);
    return () => setUnsaved(`post:${draft.id}`, false);
  }, [dirty, draft.id]);

  const patch = async (body: { text?: string; parts?: string[]; status?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ draft: Draft }>(`/drafts/${draft.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setText(out.draft.text);
      setParts(out.draft.parts && out.draft.parts.length > 1 ? out.draft.parts : null);
      onChange?.({ ...out.draft, source: draft.source ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update the post.");
    } finally {
      setBusy(false);
    }
  };
  const save = () => (parts ? patch({ parts }) : patch({ text }));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(parts ? parts.join("\n\n") : text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy. Select the text and copy it yourself.");
    }
  };

  const setPart = (i: number, value: string) => setParts((cur) => (cur ? cur.map((p, n) => (n === i ? value : p)) : cur));
  const movePart = (i: number, by: -1 | 1) =>
    setParts((cur) => {
      if (!cur || i + by < 0 || i + by >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[i + by]] = [next[i + by]!, next[i]!];
      return next;
    });
  const removePart = (i: number) => setParts((cur) => (cur && cur.length > 2 ? cur.filter((_, n) => n !== i) : cur));
  const counter = (value: string, max: number | undefined) => (
    <span className={max !== undefined && value.length > max ? "font-semibold text-danger" : ""}>
      {value.length.toLocaleString()}
      {max ? ` / ${max.toLocaleString()}` : ""}
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      {parts ? (
        <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label={`${label} thread`}>
          {parts.map((part, i) => (
            <li key={i} className="flex flex-col gap-1.5 rounded-xl border border-line bg-sunken p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-muted">
                  Part {i + 1} of {parts.length}
                  {draft.partsPosted && i < draft.partsPosted ? " · posted" : ""}
                </span>
                {!locked && (
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" aria-label={`Move part ${i + 1} up`} disabled={i === 0} onClick={() => movePart(i, -1)}>↑</Button>
                    <Button size="sm" variant="ghost" aria-label={`Move part ${i + 1} down`} disabled={i === parts.length - 1} onClick={() => movePart(i, 1)}>↓</Button>
                    <Button size="sm" variant="ghost" aria-label={`Remove part ${i + 1}`} disabled={parts.length <= 2} onClick={() => removePart(i)}>✕</Button>
                  </span>
                )}
              </div>
              <textarea aria-label={`${label} thread, part ${i + 1}`} value={part} rows={Math.min(8, Math.max(3, Math.ceil(part.length / 60)))} onChange={(e) => setPart(i, e.target.value)} disabled={locked} />
              <span className="text-[12.5px] text-muted">{counter(part, partLimit)} characters</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={`${label} post`}
            value={text}
            rows={Math.min(18, Math.max(6, Math.ceil(text.length / 60) + text.split("\n").length))}
            onChange={(e) => setText(e.target.value)}
            disabled={locked}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted">
            <span>
              {counter(text, limit)} characters{xLong ? " · X Premium: long posts on" : ""}
            </span>
            <span>AI-assisted draft{dirty ? " · unsaved edits" : ""}</span>
          </div>
        </div>
      )}
      {!locked && threadable && (
        <div className="flex flex-wrap gap-2">
          {parts ? (
            <>
              <Button size="sm" variant="secondary" disabled={parts.length >= 20} onClick={() => setParts((cur) => (cur ? [...cur, ""] : cur))} icon="plus">Add a part</Button>
              <Button size="sm" variant="ghost" onClick={() => { setText(parts.join("\n\n")); setParts(null); }}>Make it one post</Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const split = splitIntoParts(text, partLimit ?? 280).slice(0, 20);
                setParts(split.length > 1 ? split : [...split, ""]);
              }}
            >
              Split into a thread
            </Button>
          )}
        </div>
      )}
      <IssueList issues={draft.issues} />
      {error && <Alert>{error}</Alert>}
      {!locked && (
        <div className="flex flex-wrap gap-2">
          {dirty && (
            <Button variant="secondary" disabled={busy} onClick={save}>
              Save edits
            </Button>
          )}
          {draft.status !== "approved" && draft.status !== "scheduled" && draft.status !== "discarded" && (
            <Button disabled={busy || dirty} title={dirty ? "Save your edits first" : undefined} onClick={() => patch({ status: "approved" })} icon="check">
              Approve
            </Button>
          )}
          {draft.status !== "discarded" ? (
            <Button variant="danger" disabled={busy} onClick={() => patch({ status: "discarded" })}>
              Discard
            </Button>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => patch({ status: "draft" })}>
              Restore
            </Button>
          )}
          <Button variant="ghost" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
        </div>
      )}
      {(draft.status === "approved" || draft.status === "scheduled" || draft.status === "failed") && <PublishControls draft={draft} onChange={(d) => onChange?.(d)} />}
      {draft.externalUrl && (
        <a className="text-sm font-medium text-accent-ink" href={draft.externalUrl} target="_blank" rel="noreferrer">
          View the published post ↗
        </a>
      )}
      {draft.lastError && <Alert>{draft.lastError}</Alert>}
    </div>
  );
}

function PostDetail({ id, onSelect }: { id: string; onSelect: (id: string) => void }) {
  const { data, error } = useApi<{ draft: Draft }>(`/drafts/${id}`);
  const draft = data?.draft;
  const { data: siblings } = useApi<{ data: Draft[] }>(draft?.briefId ? `/drafts?briefId=${encodeURIComponent(draft.briefId)}` : null);
  if (error) return <DetailPanel><Alert>{error}</Alert></DetailPanel>;
  if (!draft) return <DetailPanel><Loading /></DetailPanel>;
  const kind = draft.source?.kind ? SOURCE_KINDS[draft.source.kind] : null;
  const others = (siblings?.data ?? []).filter((d) => d.id !== draft.id);

  return (
    <DetailPanel>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-display text-[24px] font-semibold leading-tight">{PLATFORM_LABELS[draft.platform] ?? draft.platform}</h2>
          <span className="font-mono text-[12.5px] text-muted">
            Written {formatDate(draft.createdAt)}
            {modeLabel(draft.source?.mode) ? ` · ${modeLabel(draft.source?.mode)}` : ""}
            {draft.scheduledAt && draft.status === "scheduled" ? ` · posts ${formatDate(draft.scheduledAt)}` : ""}
          </span>
        </div>
        <Tag tone={statusTone(draft.status)}>{draft.status}</Tag>
      </div>

      <section className="flex flex-col gap-2">
        <SectionLabel>Written from</SectionLabel>
        <div className="flex items-start gap-3 rounded-xl border border-line bg-sunken p-3.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent-ink"><Icon name={kind?.icon ?? "edit"} size={17} /></span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-[11.5px] uppercase tracking-[0.1em] text-muted">{kind?.label ?? "Your note"}</span>
            <span className="text-[14.5px] font-medium text-ink [overflow-wrap:anywhere]">{sourceTitle(draft)}</span>
            {draft.source?.url && (
              <a className="text-[13.5px] font-medium text-accent-ink" href={draft.source.url} target="_blank" rel="noreferrer">
                Open the source ↗
              </a>
            )}
          </div>
        </div>
      </section>

      <ResearchNotes source={draft.source} />

      <section className="flex flex-col gap-2">
        <SectionLabel>Post</SectionLabel>
        <PostEditor key={draft.id} draft={draft} />
      </section>

      <section className="flex flex-col gap-2">
        <SectionLabel>Images</SectionLabel>
        <PostImagePanel key={draft.id} draft={draft} />
      </section>

      {others.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionLabel>Also written from this</SectionLabel>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {others.map((o) => (
              <li key={o.id}>
                <button type="button" onClick={() => onSelect(o.id)} className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5 text-left hover:bg-raised">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-semibold">{PLATFORM_LABELS[o.platform] ?? o.platform}</span>
                    <span className="truncate text-[13px] text-muted">{o.text.split("\n")[0]}</span>
                  </span>
                  <Tag tone={statusTone(o.status)}>{o.status}</Tag>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </DetailPanel>
  );
}

export function DraftsPage() {
  const [params, setParams] = useQueryParams();
  const status = params.get("status") ?? "draft";
  const selected = params.get("id");
  const wide = useWide();
  const { data, error } = useApi<{ data: Draft[] }>(`/drafts?status=${status}`);
  const { data: counts } = useApi<{ statuses: Record<string, number> }>("/analytics");
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("");
  const [bulk, setBulk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Opened from a link to one post (?id=): show the tab that post is in.
  const { data: linked } = useApi<{ draft: Draft }>(selected && !params.get("status") ? `/drafts/${selected}` : null, { live: false });
  useEffect(() => {
    if (linked && linked.draft.status !== status) setParams({ status: linked.draft.status });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);

  const all = data?.data ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((d) => (!platform || d.platform === platform) && (!q || d.text.toLowerCase().includes(q) || sourceTitle(d).toLowerCase().includes(q)));
  }, [all, query, platform]);
  const usedPlatforms = [...new Set(all.map((d) => d.platform))];
  const ready = status === "draft" ? all.filter((d) => d.issues.length === 0) : [];
  const detailId = selected ?? (wide ? shown[0]?.id ?? null : null);

  // Posts written from the same material sit together under one heading.
  const groups: { key: string; title: string; kind: string | null; items: Draft[] }[] = [];
  for (const d of shown) {
    const key = d.briefId ?? d.id;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(d);
    else groups.push({ key, title: sourceTitle(d), kind: d.source?.kind ?? null, items: [d] });
  }

  const approveAll = async () => {
    setBusy(true);
    setBulk(null);
    try {
      const out = await api<{ approved: string[]; skipped: { reason: string }[] }>("/drafts/bulk-approve", { method: "POST", body: JSON.stringify({ ids: ready.slice(0, 50).map((d) => d.id) }) });
      setBulk(`Approved ${out.approved.length}.${out.skipped.length ? ` Skipped ${out.skipped.length}: ${out.skipped[0]!.reason}` : ""}`);
    } catch (err) {
      setBulk(err instanceof Error ? err.message : "Couldn't approve.");
    } finally {
      setBusy(false);
    }
  };

  const list = (
    <div className="flex flex-col gap-3">
      {status === "draft" && all.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-line bg-panel px-4 py-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ok-soft text-ok"><Icon name="check" size={16} strokeWidth={2.2} /></span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-[14.5px] font-semibold">{ready.length} of {all.length} ready to approve</span>
            <span className="text-[13px] text-muted">{all.length - ready.length ? `${all.length - ready.length} need a check first.` : "None have warnings."}</span>
          </div>
          {ready.length > 0 && <Button size="sm" disabled={busy} onClick={approveAll}>{busy ? "Approving…" : `Approve ${Math.min(50, ready.length)}`}</Button>}
        </div>
      )}
      {bulk && <Alert tone="info">{bulk}</Alert>}
      <div className="overflow-hidden rounded-[18px] border border-line bg-panel">
        <div className="flex flex-wrap gap-2 border-b border-line p-3 sm:p-4">
          <label className="relative m-0 min-w-[180px] flex-1">
            <span className="sr-only">Search posts</span>
            <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search posts or sources…" className="!pl-9" />
          </label>
          {usedPlatforms.length > 1 && (
            <label className="m-0">
              <span className="sr-only">Platform</span>
              <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">All platforms</option>
                {usedPlatforms.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p] ?? p}</option>)}
              </select>
            </label>
          )}
        </div>
        {!data && !error && <div className="p-5"><Loading /></div>}
        {error && <div className="p-4"><Alert>{error}</Alert></div>}
        {data && shown.length === 0 && (
          <Empty
            icon="posts"
            title={all.length ? "Nothing matches" : `No ${STATUSES.find((s) => s.id === status)?.label.toLowerCase() ?? ""} posts`}
            body={all.length ? "Try another word or platform." : status === "draft" ? "Write something new, or turn an idea into posts." : "Posts move here as you approve, schedule and publish them."}
            action={!all.length && status === "draft" ? <LinkButton to="/app/new" size="sm">New post</LinkButton> : undefined}
          />
        )}
        {groups.map((g) => (
          <div key={g.key}>
            <div className="flex items-center gap-2 border-b border-line bg-sunken px-4 py-2 sm:px-5">
              <Icon name={(g.kind && SOURCE_KINDS[g.kind]?.icon) || "edit"} size={14} className="shrink-0 text-muted" />
              <span className="truncate font-mono text-[11.5px] uppercase tracking-[0.1em] text-muted">{g.title}</span>
            </div>
            <ul className="m-0 list-none p-0">
              {g.items.map((d) => (
                <ListItem key={d.id} selected={d.id === detailId} onSelect={() => setParams({ id: d.id }, true)} label={`${PLATFORM_LABELS[d.platform] ?? d.platform} post: ${d.text.slice(0, 60)}`}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-ink">{PLATFORM_LABELS[d.platform] ?? d.platform}</span>
                    <span className="flex flex-wrap justify-end gap-1.5">
                      {d.issues.length > 0 && <Tag tone={d.issues.some((i) => i.severity === "error") ? "danger" : "warn"}>{d.issues.length} to check</Tag>}
                      <Tag tone={statusTone(d.status)}>{d.status}</Tag>
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[14px] leading-snug text-ink-2">{d.text}</span>
                  <span className="font-mono text-[12px] text-muted">{d.status === "scheduled" && d.scheduledAt ? `Posts ${formatDate(d.scheduledAt)}` : d.status === "published" && d.publishedAt ? `Published ${timeAgo(d.publishedAt)}` : `Written ${timeAgo(d.createdAt)}`}</span>
                </ListItem>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Posts" subtitle="Everything you’ve written: waiting, scheduled, or out in the world." actions={<LinkButton to="/app/new" variant="inverse" icon="plus">New post</LinkButton>} />
      <StatStrip
        label="Post status"
        active={status}
        onPick={(id) => setParams({ status: id, id: null })}
        items={STATUSES.map((s) => ({ id: s.id, label: s.label, value: counts?.statuses[s.id] ?? 0, tone: s.tone }))}
      />
      <Split
        hasSelection={Boolean(selected)}
        onBack={() => setParams({ id: null })}
        backLabel="All posts"
        list={list}
        detail={
          detailId ? (
            <PostDetail key={detailId} id={detailId} onSelect={(id) => setParams({ id }, true)} />
          ) : (
            <DetailPanel>
              <Empty icon="posts" title="Pick a post" body="Its details, where it came from and what to do next appear here." />
            </DetailPanel>
          )
        }
      />
    </div>
  );
}
