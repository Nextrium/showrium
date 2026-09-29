import { useEffect, useState, type FormEvent } from "react";
import { api, timeAgo, useApi } from "../../lib";
import { Link } from "../../ui/Link";
import { Alert, Badge, Button, Empty, Icon, PageHeader, Panel, type IconName } from "../../ui/kit";
import { UploadForm } from "../../components/UploadForm";

type Source = { id: string; kind: "github_repo" | "rss" | "page"; key: string; lastCheckedAt: string | null; lastError: string | null };
type ContextItem = { id: string; kind: string; title: string; body: string; url: string | null; createdAt: string };
type Usage = { sources: { limit: number } };

type CatalogItem = { id: string; name: string; body: string; icon: IconName; kind?: "github_repo" | "rss"; placeholder?: string; label?: string };
const CATALOG: { group: string; items: CatalogItem[] }[] = [
  {
    group: "For builders",
    items: [
      { id: "github", name: "GitHub repository", body: "Releases, plus each day’s commits and merged pull requests. Public repositories; no release needed.", icon: "git", kind: "github_repo", placeholder: "owner/repository", label: "Repository" },
      { id: "devto", name: "Dev.to, Hashnode or Medium", body: "Your articles as soon as they go live. Paste your profile or blog address.", icon: "sources", kind: "rss", placeholder: "https://dev.to/yourname", label: "Address" },
      { id: "mcp", name: "AI coding tools", body: "Claude Code or Cursor can tell Showrium what you shipped, through the MCP server.", icon: "code" },
    ],
  },
  {
    group: "For writers and creators",
    items: [
      { id: "rss", name: "Blog, newsletter or website", body: "Paste the page that lists your posts. Showrium finds its feed, or watches the page for new articles.", icon: "globe", kind: "rss", placeholder: "https://example.com/blog", label: "Address" },
      { id: "youtube", name: "YouTube channel", body: "Each new video becomes posts that point people to it.", icon: "play", kind: "rss", placeholder: "https://www.youtube.com/@yourchannel", label: "Channel address" },
      { id: "podcast", name: "Podcast", body: "New episodes become posts. Paste your show’s RSS feed or website (from Spotify for Podcasters, Buzzsprout, Transistor…).", icon: "voice", kind: "rss", placeholder: "https://feeds.example.com/show.xml", label: "Feed or website" },
    ],
  },
  {
    group: "For everyday moments",
    items: [
      { id: "note", name: "Notes, links and voice", body: "Write a line, paste a link, or record a voice note from New post.", icon: "edit" },
      { id: "prompt", name: "Daily prompt", body: "A short question each day on Home, matched to what you do. Answer in a sentence.", icon: "comment" },
      { id: "photos", name: "Photos and documents", body: "A photo of your work, a whiteboard, slides or a PDF. Showrium reads it for you.", icon: "photo" },
    ],
  },
];

function SourceRow({ s, onRemoved }: { s: Source; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const check = async () => {
    setBusy(true);
    setResult(null);
    try {
      const out = await api<{ added: number; error: string | null }>(`/sources/${s.id}/sync`, { method: "POST" });
      setResult(out.error ? { tone: "warn", text: out.error } : { tone: "ok", text: out.added ? `${out.added} new item${out.added === 1 ? "" : "s"} added` : "Nothing new since the last check" });
    } catch (err) {
      setResult({ tone: "warn", text: err instanceof Error ? err.message : "Check failed." });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(`Stop watching ${s.key}? Posts already written stay.`)) return;
    await api(`/sources/${s.id}`, { method: "DELETE" }).catch(() => undefined);
    onRemoved();
  };
  const status = result ?? (s.lastError ? { tone: "warn" as const, text: s.lastError } : s.lastCheckedAt ? { tone: "ok" as const, text: `Checked ${timeAgo(s.lastCheckedAt)}` } : { tone: "warn" as const, text: "Not checked yet" });
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-line py-3.5 first:border-t-0">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-raised text-ink-2"><Icon name={s.kind === "github_repo" ? "git" : s.kind === "page" ? "globe" : "sources"} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-semibold">{s.key}</span>
        <span className="text-[13px] text-muted">{s.kind === "github_repo" ? "GitHub · releases, commits and merged pull requests" : s.kind === "page" ? "Web page · watched for new articles" : "Feed"}</span>
      </div>
      <span role="status" className={`text-[13px] sm:max-w-[300px] ${status.tone === "ok" ? "text-ok" : "text-warn"}`}>{status.text}</span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" icon="refresh" disabled={busy} onClick={check}>{busy ? "Checking…" : "Check now"}</Button>
        <Button variant="ghost" size="sm" aria-label={`Remove ${s.key}`} onClick={remove}><Icon name="trash" size={16} /></Button>
      </div>
    </li>
  );
}

function AddForm({ item, onDone, onCancel }: { item: CatalogItem; onDone: (notice: string) => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("value")).trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string; key: string; note: string | null }>("/sources", { method: "POST", body: JSON.stringify(item.kind === "github_repo" ? { kind: "github_repo", repo: value } : { kind: "rss", url: value }) });
      // First check straight away, so people see what was found.
      const out = await api<{ added: number; error: string | null }>(`/sources/${created.id}/sync`, { method: "POST" }).catch(() => null);
      const found = out?.error ? ` The first check said: ${out.error}` : out ? ` ${out.added ? `${out.added} new item${out.added === 1 ? "" : "s"} found.` : "Nothing new yet."}` : "";
      onDone(`Connected ${created.key}.${created.note ? ` ${created.note}` : ""}${found}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the source.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-2xl border border-accent bg-accent-soft p-4">
      <span className="font-semibold">Add {item.name.toLowerCase()}</span>
      <label>
        {item.label}
        <input name="value" required autoFocus placeholder={item.placeholder} className="!bg-panel" />
      </label>
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <Button disabled={busy}>{busy ? "Adding and checking…" : "Add and check"}</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function SourcesPage() {
  const sources = useApi<{ data: Source[] }>("/sources");
  const contexts = useApi<{ data: ContextItem[] }>("/contexts");
  const { data: usage } = useApi<Usage>("/usage");
  const [adding, setAdding] = useState<CatalogItem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // /app/sources?add=github (from onboarding) opens that form straight away.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("add");
    if (!id) return;
    window.history.replaceState(null, "", "/app/sources");
    if (id === "photos") setUploading(true);
    else setAdding(CATALOG.flatMap((g) => g.items).find((i) => i.id === id && i.kind) ?? null);
  }, []);
  const count = sources.data?.data.length ?? 0;
  const limit = usage?.sources.limit;
  const full = limit !== undefined && count >= limit;

  return (
    <>
      <PageHeader title="Sources" subtitle="Where Showrium looks for things worth sharing. Each one is checked every few hours." />

      <Panel title={`Connected${limit !== undefined ? ` (${count} of ${limit})` : ""}`} id="connected">
        {sources.error && <Alert>{sources.error}</Alert>}
        {sources.data?.data.length === 0 ? (
          <Empty icon="sources" title="No sources yet" body="Add one below, and new ideas will appear in Ideas as things happen." />
        ) : (
          <ul className="m-0 list-none p-0">{sources.data?.data.map((s) => <SourceRow key={s.id} s={s} onRemoved={() => sources.reload()} />)}</ul>
        )}
      </Panel>

      <div className="flex flex-col gap-3">
        <h2 className="font-sans text-base font-semibold tracking-normal">Add a source</h2>
        {full && <Alert tone="warn">Your plan’s {limit} source{limit === 1 ? " is" : "s are"} in use. Remove one, or upgrade in Billing.</Alert>}
        {notice && <Alert tone="ok">{notice}</Alert>}
        {uploading && (
          <div className="flex flex-col gap-3 rounded-2xl border border-accent bg-accent-soft p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold">Upload a photo or document</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setUploading(false)}>Close</Button>
            </div>
            <UploadForm
              onUploaded={(item) => {
                setUploading(false);
                setNotice(`Added “${item.title}”. It’s in your ideas and in the material below.`);
              }}
            />
          </div>
        )}
        {adding && (
          <AddForm
            item={adding}
            onCancel={() => setAdding(null)}
            onDone={(n) => {
              setAdding(null);
              setNotice(n);
            }}
          />
        )}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {CATALOG.map((g) => (
            <Panel key={g.group}>
              <span className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted">{g.group}</span>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {g.items.map((item) => {
                  const available = true;
                  const inner = (
                    <>
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-raised text-accent-ink"><Icon name={item.icon} size={17} /></span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex items-center gap-2 text-sm font-semibold text-ink">{item.name}{!available && <Badge>Soon</Badge>}</span>
                        <span className="text-[12.5px] leading-snug text-muted">{item.body}</span>
                      </span>
                    </>
                  );
                  const cls = "flex w-full items-start gap-3 rounded-xl border border-transparent p-2.5 text-left";
                  return (
                    <li key={item.id}>
                      {item.kind ? (
                        <button type="button" disabled={full} onClick={() => { setNotice(null); setAdding(item); }} className={`${cls} cursor-pointer bg-transparent hover:border-line-strong hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-60`}>{inner}</button>
                      ) : item.id === "note" ? (
                        <Link to="/app/new" className={`${cls} no-underline hover:border-line-strong hover:bg-sunken`}>{inner}</Link>
                      ) : item.id === "prompt" ? (
                        <Link to="/app" className={`${cls} no-underline hover:border-line-strong hover:bg-sunken`}>{inner}</Link>
                      ) : item.id === "photos" ? (
                        <button type="button" onClick={() => { setNotice(null); setUploading(true); setAdding(null); }} className={`${cls} cursor-pointer bg-transparent hover:border-line-strong hover:bg-sunken`}>{inner}</button>
                      ) : item.id === "mcp" ? (
                        <Link to="/app/settings" className={`${cls} no-underline hover:border-line-strong hover:bg-sunken`}>{inner}</Link>
                      ) : (
                        <div className={`${cls} opacity-70`}>{inner}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ))}
        </div>
      </div>

      <Panel title="Material you can post about" id="material">
        {contexts.data?.data.length === 0 && <span className="text-sm text-muted">Nothing yet. Add a source above, or write a note in New post.</span>}
        <ul className="m-0 flex list-none flex-col p-0">
          {contexts.data?.data.slice(0, 20).map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 border-t border-line py-3 first:border-t-0">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">{c.title || c.body.slice(0, 90)}</span>
                <span className="text-[12.5px] text-muted">{c.kind.replace(/_/g, " ")} · {timeAgo(c.createdAt)}</span>
              </div>
              <Link to={`/app/new?context=${c.id}`} className="text-sm no-underline">Write posts →</Link>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
