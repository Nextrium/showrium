import { useState } from "react";
import { authClient, navigate, useApi } from "../../lib";
import { planLabel } from "../../shell/AppShell";
import { Link } from "../../ui/Link";
import { Badge, Button, Dot, Empty, Icon, LinkButton, Meter, PageHeader, Panel } from "../../ui/kit";
import type { Draft, Persona } from "./shared";

type Idea = { id: string; reason: string; title: string; createdAt: string };
type Usage = { plan: string; posts: { used: number; limit: number }; videos: { used: number; limit: number } };
type Connection = { id: string; platform: string; handle: string; status: string };
type Me = { workspace: { plan: string; fullAccess: boolean } };

export const QUICK_KEY = "showrium_quick_note";
const NAMES: Record<string, string> = { x: "X", linkedin: "LinkedIn", tiktok: "TikTok", bluesky: "Bluesky", mastodon: "Mastodon", threads: "Threads", instagram: "Instagram", facebook: "Facebook", youtube_shorts: "YouTube Shorts" };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function QuickCreate({ persona }: { persona: Persona | null }) {
  const [text, setText] = useState("");
  const start = () => {
    try {
      sessionStorage.setItem(QUICK_KEY, text);
    } catch {
      // The text just won't carry over.
    }
    navigate("/app/new");
  };
  return (
    <Panel title="What did you work on?" id="qc" action={<span className="hidden text-[13px] text-muted sm:inline">One input. A post for every platform.</span>}>
      <label className="sr-only" htmlFor="quick">Material to post about</label>
      <textarea
        id="quick"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste a link, or write a quick note about what you did…"
        className="!rounded-[14px] !bg-sunken !px-4 !py-3.5"
      />
      <div className="flex flex-wrap items-center gap-2">
        {(persona?.platforms ?? []).slice(0, 4).map((p) => (
          <span key={p} className="rounded-full bg-raised px-2.5 py-1 text-[13px] text-ink-2">{NAMES[p] ?? p}</span>
        ))}
        {persona && persona.platforms.length > 4 && <span className="rounded-full border border-dashed border-line-strong px-2.5 py-1 text-[13px] text-muted">+{persona.platforms.length - 4}</span>}
        {!persona && <Link to="/app/voice" className="text-sm">Set up your voice first →</Link>}
        <span className="flex-1" />
        <span className="hidden sm:inline-flex"><LinkButton to="/app/new" variant="secondary" icon="voice">Voice note</LinkButton></span>
        <Button icon="arrowRight" disabled={!text.trim()} onClick={start}>Write posts</Button>
      </div>
    </Panel>
  );
}

export function AppHome() {
  const { data: session } = authClient.useSession();
  const { data: persona } = useApi<{ persona: Persona | null }>("/persona");
  const { data: drafts } = useApi<{ data: Draft[] }>("/drafts?status=draft");
  const { data: scheduled } = useApi<{ data: Draft[] }>("/drafts?status=scheduled");
  const { data: ideas } = useApi<{ data: Idea[] }>("/ideas");
  const { data: usage } = useApi<Usage>("/usage");
  const { data: credits } = useApi<{ balance: number }>("/credits");
  const { data: conns } = useApi<{ data: Connection[] }>("/connections");
  const { data: me } = useApi<Me>("/me");

  const waiting = drafts?.data ?? [];
  const ready = waiting.filter((d) => d.issues.length === 0).length;
  const upNext = [...(scheduled?.data ?? [])].sort((a, b) => (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? "")).slice(0, 3);
  const firstName = session?.user.name?.split(/\s+/)[0] ?? "";

  return (
    <>
      <PageHeader
        title={`${greeting()}${firstName ? `, ${firstName}` : ""}`}
        subtitle={
          scheduled && drafts
            ? `${upNext.length ? `${scheduled.data.length} post${scheduled.data.length === 1 ? "" : "s"} scheduled.` : "Nothing scheduled yet."} ${waiting.length ? `${waiting.length} draft${waiting.length === 1 ? " is" : "s are"} waiting for you.` : ""}`
            : " "
        }
      />

      {persona && !persona.persona && (
        <Panel className="border-accent/40 bg-accent-soft">
          <div className="flex flex-wrap items-center gap-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-on-accent"><Icon name="voice" /></span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-semibold">Start with your voice</span>
              <span className="text-sm text-ink-2">Two minutes: who you are, how you sound and where you post. Every post is written from it.</span>
            </div>
            <LinkButton to="/app/voice">Set up my voice</LinkButton>
          </div>
        </Panel>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <QuickCreate persona={persona?.persona ?? null} />
          <div className="grid gap-5 md:grid-cols-2">
            <Panel title="Up next" id="upnext" action={<Link to="/app/posts" className="text-[13.5px] no-underline">All posts →</Link>}>
              {upNext.length === 0 ? (
                <Empty icon="calendar" title="Nothing scheduled" body="Approve a draft and pick a time, or let automation schedule clean posts." />
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {upNext.map((p) => (
                    <li key={p.id} className="flex gap-3.5 border-t border-line py-3 first:border-t-0">
                      <div className="flex w-16 shrink-0 flex-col">
                        <span className="text-[13.5px] font-semibold">{new Date(p.scheduledAt!).toLocaleDateString(undefined, { weekday: "short" })}</span>
                        <span className="font-mono text-[12.5px] text-muted">{new Date(p.scheduledAt!).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-[12.5px] font-semibold text-ink-2">{NAMES[p.platform] ?? p.platform}</span>
                        <span className="line-clamp-2 text-sm text-ink-2">{p.text}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel title="Fresh ideas" id="ideas" action={<Link to="/app/ideas" className="text-[13.5px] no-underline">All ideas →</Link>}>
              {ideas && ideas.data.length === 0 ? (
                <Empty icon="ideas" title="No new ideas" body="Connect a repository, blog or channel in Sources, and ideas show up here." action={<LinkButton to="/app/sources" variant="secondary" size="sm">Add a source</LinkButton>} />
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {ideas?.data.slice(0, 3).map((i) => (
                    <li key={i.id} className="flex items-center gap-3 border-t border-line py-3 first:border-t-0">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-raised text-accent-ink"><Icon name="ideas" size={16} /></span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.reason}</span>
                      <LinkButton to="/app/ideas" variant="secondary" size="sm">Write</LinkButton>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </div>

        <aside className="flex min-w-0 flex-col gap-5">
          <Panel title="Waiting for you" id="waiting" className="bg-raised">
            <div className="flex items-baseline gap-2.5">
              <span className="font-display text-[40px] font-semibold leading-none">{waiting.length}</span>
              <span className="text-sm text-muted">{waiting.length ? `draft${waiting.length === 1 ? "" : "s"}: ${ready} ready, ${waiting.length - ready} to check` : "drafts. You're all caught up."}</span>
            </div>
            {waiting.length > 0 && (
              <div className="flex gap-2">
                <LinkButton to="/app/posts" className="flex-1">{ready ? `Review ${ready} ready` : "Review drafts"}</LinkButton>
              </div>
            )}
          </Panel>
          <Panel title="This month" id="month" action={<Link to="/app/billing" className="text-[13.5px] no-underline">Usage →</Link>}>
            {usage ? (
              <div className="flex flex-col gap-3.5">
                <Meter label="AI posts" value={usage.posts.used} max={usage.posts.limit} />
                <Meter label="Videos" value={usage.videos.used} max={usage.videos.limit} />
                <div className="flex items-center justify-between text-[13.5px]">
                  <span className="text-ink-2">Credits</span>
                  <span className="font-mono text-muted">{credits?.balance ?? "–"}</span>
                </div>
                <div className="flex items-center justify-between text-[13.5px]">
                  <span className="text-ink-2">Plan</span>
                  <Badge tone={me?.workspace.fullAccess ? "info" : "neutral"}>{planLabel(me?.workspace.plan ?? usage.plan, me?.workspace.fullAccess)}</Badge>
                </div>
              </div>
            ) : (
              <span className="text-sm text-muted">Loading…</span>
            )}
          </Panel>
          <Panel title="Accounts" id="accts" action={<Link to="/app/accounts" className="text-[13.5px] no-underline">Manage →</Link>}>
            {conns && conns.data.length === 0 && <span className="text-sm text-muted">None connected. Tap-to-post works without connecting.</span>}
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {conns?.data.map((c) => (
                <li key={c.id} className="flex items-center gap-2.5 text-sm">
                  <Dot tone={c.status === "active" ? "ok" : "warn"} />
                  <span className="flex-1 truncate">{NAMES[c.platform] ?? c.platform} <span className="text-muted">{c.handle}</span></span>
                  <span className="text-[13px] text-muted">{c.status === "active" ? "Connected" : "Reconnect"}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </div>
    </>
  );
}
