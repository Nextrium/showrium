import { useEffect, useMemo, useState } from "react";
import { api, formatDate, navigate, timeAgo, useApi } from "../../lib";
import { MODES, usePlatforms, type Draft, type Persona, type Platform } from "./shared";
import { PLATFORM_LABELS, SOURCE_KINDS, THREAD_PLATFORMS } from "./Drafts";
import { Alert, Button, Chip, Empty, Icon, LinkButton, Loading, PageHeader, Switch } from "../../ui/kit";
import { DetailPanel, ListItem, SectionLabel, Split, StatStrip, Tag, useQueryParams } from "../../ui/split";

type IdeaStatus = "new" | "drafted" | "dismissed";
type Idea = { id: string; reason: string; score: number; status: IdeaStatus; title: string; kind: string; body: string; url: string | null; createdAt: string };
type Counts = Record<IdeaStatus, number>;

const TABS = [
  { id: "new", label: "New", tone: "accent" },
  { id: "drafted", label: "Written", tone: "ok" },
  { id: "dismissed", label: "Not now", tone: "neutral" },
] as const;

const fitTone = (score: number) => (score >= 70 ? "ok" : score >= 50 ? "accent" : "neutral");
const kindOf = (kind: string) => SOURCE_KINDS[kind] ?? { label: "Material", icon: "doc" as const };

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

function IdeaDetail({ id, persona }: { id: string; persona: Persona | null }) {
  const { data, error } = useApi<{ idea: Idea & { briefId: string | null } }>(`/ideas/${id}`);
  const idea = data?.idea;
  const { data: posts } = useApi<{ data: Draft[] }>(idea?.briefId ? `/drafts?briefId=${encodeURIComponent(idea.briefId)}` : null);
  const platforms = usePlatforms().filter((p) => persona?.platforms.includes(p.id));
  const [mode, setMode] = useState<string>("build_in_public");
  const [chosen, setChosen] = useState<Platform[]>(persona?.platforms ?? []);
  const [thread, setThread] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (persona && !chosen.length) setChosen(persona.platforms);
  }, [persona]); // eslint-disable-line react-hooks/exhaustive-deps

  // Suggest a style from the material: code work → build in public; articles → teach; your photos/answers → smile.
  useEffect(() => {
    if (!idea) return;
    setMode(idea.kind.startsWith("github") ? "build_in_public" : idea.kind === "rss_item" || idea.kind === "document" ? "teach" : idea.kind === "photo" || idea.kind === "prompt" ? "smile" : "build_in_public");
  }, [idea?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <DetailPanel><Alert>{error}</Alert></DetailPanel>;
  if (!idea) return <DetailPanel><Loading /></DetailPanel>;
  const kind = kindOf(idea.kind);

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setFailure(null);
    try {
      await fn();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  };
  const write = () =>
    act("write", async () => {
      const out = await api<{ drafts: Draft[] }>(`/ideas/${idea.id}/compose`, { method: "POST", body: JSON.stringify({ mode, platforms: chosen, thread: thread && chosen.some((p) => THREAD_PLATFORMS.includes(p)) }) });
      // Straight to the new posts, so it's clear where they went.
      if (out.drafts[0]) navigate(`/app/posts?id=${out.drafts[0].id}`);
    });

  return (
    <DetailPanel>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="font-display text-[22px] font-semibold leading-tight [overflow-wrap:anywhere]">{idea.title || idea.reason}</h2>
          <span className="font-mono text-[12.5px] text-muted">{kind.label} · found {formatDate(idea.createdAt)}</span>
        </div>
        <Tag tone={fitTone(idea.score)}>Fit {idea.score}%</Tag>
      </div>

      <section className="flex flex-col gap-2">
        <SectionLabel>Why it’s worth a post</SectionLabel>
        <p className="m-0 text-[14.5px] text-ink-2">{idea.reason}</p>
      </section>

      <section className="flex flex-col gap-2">
        <SectionLabel>The material</SectionLabel>
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl border border-line bg-sunken p-3.5 text-[14px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">
          {idea.body || "No text, just the title."}
        </div>
        {idea.url && (
          <a className="text-[13.5px] font-medium text-accent-ink" href={idea.url} target="_blank" rel="noreferrer">
            Open the source ↗
          </a>
        )}
      </section>

      {idea.status === "new" && (
        <section className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent-soft/40 p-4">
          <SectionLabel>Write posts from this</SectionLabel>
          {!platforms.length ? (
            <p className="m-0 text-sm text-muted">Choose your platforms in Brand voice first.</p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-ink-2">Style</span>
                <div className="flex flex-wrap gap-2">
                  {MODES.map((m) => <Chip key={m.id} on={mode === m.id} onClick={() => setMode(m.id)} title={m.hint}>{m.label}</Chip>)}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-ink-2">Platforms</span>
                <div className="flex flex-wrap gap-2">
                  {platforms.map((p) => (
                    <Chip key={p.id} on={chosen.includes(p.id)} onClick={() => setChosen((cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]))}>
                      {p.label}
                    </Chip>
                  ))}
                </div>
              </div>
              {chosen.some((p) => THREAD_PLATFORMS.includes(p)) && (
                <label className="flex items-center justify-between gap-3 text-[13.5px] font-medium text-ink-2">
                  Write as a thread on {chosen.filter((p) => THREAD_PLATFORMS.includes(p)).map((p) => PLATFORM_LABELS[p] ?? p).join(", ")}
                  <Switch label="Write as a thread" on={thread} onChange={setThread} />
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                <Button disabled={Boolean(busy) || !chosen.length} onClick={write} icon="edit">
                  {busy === "write" ? "Writing…" : `Write ${chosen.length} post${chosen.length === 1 ? "" : "s"}`}
                </Button>
                <Button variant="ghost" disabled={Boolean(busy)} onClick={() => act("dismiss", () => api(`/ideas/${idea.id}/dismiss`, { method: "POST" }))}>
                  Not now
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {idea.status === "dismissed" && (
        <Button variant="secondary" className="self-start" disabled={Boolean(busy)} onClick={() => act("restore", () => api(`/ideas/${idea.id}/restore`, { method: "POST" }))}>
          Bring it back
        </Button>
      )}

      {idea.status === "drafted" && (
        <section className="flex flex-col gap-2">
          <SectionLabel>Posts written from this</SectionLabel>
          {!posts ? (
            <Loading />
          ) : posts.data.length === 0 ? (
            <p className="m-0 text-sm text-muted">No posts found. They may have been removed.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {posts.data.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => navigate(`/app/posts?id=${o.id}`)} className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-2.5 text-left hover:bg-raised">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-semibold">{PLATFORM_LABELS[o.platform] ?? o.platform}</span>
                      <span className="truncate text-[13px] text-muted">{o.text.split("\n")[0]}</span>
                    </span>
                    <Tag tone={o.status === "published" ? "ok" : o.status === "discarded" ? "neutral" : "accent"}>{o.status}</Tag>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {failure && <Alert>{failure}</Alert>}
    </DetailPanel>
  );
}

export function IdeasPage() {
  const [params, setParams] = useQueryParams();
  const status = (params.get("status") as IdeaStatus | null) ?? "new";
  const selected = params.get("id");
  const wide = useWide();
  const { data: personaData } = useApi<{ persona: Persona | null }>("/persona");
  const { data, error } = useApi<{ data: Idea[]; counts: Counts }>(`/ideas?status=${status}`);
  const [query, setQuery] = useState("");

  const all = data?.data ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((i) => `${i.reason} ${i.title} ${i.body}`.toLowerCase().includes(q)) : all;
  }, [all, query]);
  const detailId = selected ?? (wide ? shown[0]?.id ?? null : null);

  const list = (
    <div className="overflow-hidden rounded-[18px] border border-line bg-panel">
      <div className="border-b border-line p-3 sm:p-4">
        <label className="relative m-0 block">
          <span className="sr-only">Search ideas</span>
          <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ideas…" className="!pl-9" />
        </label>
      </div>
      {!data && !error && <div className="p-5"><Loading /></div>}
      {error && <div className="p-4"><Alert>{error}</Alert></div>}
      {data && shown.length === 0 && (
        <Empty
          icon="ideas"
          title={all.length ? "Nothing matches" : status === "new" ? "No new ideas yet" : status === "drafted" ? "Nothing written yet" : "Nothing set aside"}
          body={all.length ? "Try another word." : status === "new" ? "Connect a source, upload a photo, or answer today’s question on Home, and ideas appear here." : "Ideas move here as you use them."}
          action={!all.length && status === "new" ? <LinkButton to="/app/sources" size="sm">Add a source</LinkButton> : undefined}
        />
      )}
      <ul className="m-0 list-none p-0">
        {shown.map((i) => {
          const kind = kindOf(i.kind);
          return (
            <ListItem key={i.id} selected={i.id === detailId} onSelect={() => setParams({ id: i.id }, true)} label={i.reason}>
              <span className="flex items-start justify-between gap-2">
                <span className="font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{i.title || i.reason}</span>
                <Tag tone={fitTone(i.score)}>Fit {i.score}%</Tag>
              </span>
              {i.body && <span className="line-clamp-2 text-[14px] leading-snug text-ink-2">{i.body}</span>}
              <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                <Icon name={kind.icon} size={13} className="shrink-0" />
                <span>{kind.label}</span>
                <span className="ml-auto font-mono">{timeAgo(i.createdAt)}</span>
              </span>
            </ListItem>
          );
        })}
      </ul>
    </div>
  );

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Ideas" subtitle="Post-worthy moments from your sources, uploads and answers. Pick one to see it and write from it." actions={<LinkButton to="/app/sources" variant="secondary" icon="sources">Sources</LinkButton>} />
      <div className="max-w-xl">
        <StatStrip
          label="Idea status"
          active={status}
          onPick={(id) => setParams({ status: id, id: null })}
          items={TABS.map((t) => ({ id: t.id, label: t.label, value: data?.counts[t.id] ?? 0, tone: t.tone }))}
        />
      </div>
      <Split
        hasSelection={Boolean(selected)}
        onBack={() => setParams({ id: null })}
        backLabel="All ideas"
        list={list}
        detail={
          detailId ? (
            <IdeaDetail key={detailId} id={detailId} persona={personaData?.persona ?? null} />
          ) : (
            <DetailPanel>
              <Empty icon="ideas" title="Pick an idea" body="See the material behind it and turn it into posts in one step." />
            </DetailPanel>
          )
        }
      />
    </div>
  );
}
