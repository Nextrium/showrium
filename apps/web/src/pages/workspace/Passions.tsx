// Passions: subjects the person cares about (a project, an ecosystem, a cause), each with its own
// sources. New items become ideas; posts are the person's view of it, with an optional disclosure.
import { useState, type FormEvent } from "react";
import { api, useApi } from "../../lib";
import { Alert, Badge, Button, Chip, Empty, Icon, Info, PageHeader, Panel, Switch } from "../../ui/kit";
import { SourceRow, type Source } from "./Sources";

type Relation = "follow" | "involved" | "ours";
type Passion = { id: string; name: string; about: string; disclosure: string; active: boolean; live: boolean; startsOn: string | null; endsOn: string | null; relation: Relation; linkSource: boolean; xHandle: string; xHandles: string[]; topics: string[]; sources: Source[] };
/** A comma-separated field as a list (X accounts may also be separated by spaces). */
const listOf = (value: FormDataEntryValue | null, spaces = false) =>
  String(value ?? "")
    .split(spaces ? /[,\s]+/ : /,/)
    .map((v) => v.trim())
    .filter(Boolean);
const RELATIONS: { id: Relation; label: string }[] = [
  { id: "follow", label: "I follow it" },
  { id: "involved", label: "I'm involved" },
  { id: "ours", label: "It's ours" },
];
type List = { data: Passion[]; limits: { passions: number; sourcesEach: number } };

/** "owner/repo" or a github.com address is a repository; "@name" an X account; anything else is a website, feed, channel or podcast. */
function sourceBody(value: string) {
  const v = value.trim().replace(/\/+$/, "");
  const repo = v.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo) && (repo !== v || !v.includes("."))) return { kind: "github_repo", repo };
  // "@name" is an X account (followed through X's API).
  if (/^@[A-Za-z0-9_]{1,15}$/.test(v)) return { kind: "rss", url: `https://x.com/${v.slice(1)}` };
  return { kind: "rss", url: /^https?:\/\//i.test(v) ? v : `https://${v}` };
}

function AddSource({ passion, full, onAdded }: { passion: Passion; full: boolean; onAdded: (note: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const value = String(new FormData(form).get("source") ?? "").trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string; key: string; note: string | null }>(`/passions/${passion.id}/sources`, { method: "POST", body: JSON.stringify(sourceBody(value)) });
      // First check straight away, so people see what was found.
      const out = await api<{ added: number; error: string | null }>(`/sources/${created.id}/sync`, { method: "POST" }).catch(() => null);
      form.reset();
      onAdded(`Added ${created.key}.${created.note ? ` ${created.note}` : ""}${out?.error ? ` First check: ${out.error}` : out ? ` ${out.added ? `${out.added} new item${out.added === 1 ? "" : "s"}.` : "Nothing new yet."}` : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that source.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            Add a source <Info label="About sources">A news site, blog, YouTube channel, podcast or GitHub repository about it. Paste its address.</Info>
          </span>
          <input name="source" required disabled={full} placeholder={full ? "This passion's sources are full" : "https://example.com/news or owner/repository"} />
        </label>
        <Button disabled={busy || full}>{busy ? "Adding…" : "Add"}</Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </form>
  );
}

function Details({ passion, onSaved }: { passion: Passion; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [relation, setRelation] = useState<Relation>(passion.relation);
  const [linkSource, setLinkSource] = useState(passion.linkSource);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api(`/passions/${passion.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: String(f.get("name") ?? ""),
          about: String(f.get("about") ?? ""),
          disclosure: String(f.get("disclosure") ?? ""),
          startsOn: String(f.get("startsOn") ?? "") || null,
          endsOn: String(f.get("endsOn") ?? "") || null,
          relation,
          linkSource,
          xHandles: listOf(f.get("xHandles"), true),
          topics: listOf(f.get("topics")),
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="flex flex-col gap-3 rounded-xl border border-line bg-sunken p-3.5">
      <label>
        Name
        <input name="name" required maxLength={60} defaultValue={passion.name} />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
          Your connection{" "}
          <Info label="About your connection">
            I follow it: posts are your view, and the project is named, never "we". I'm involved (contributor, ambassador, partner): "I" for what you did, and the team gets credit. It's ours (your own team): posts say "we" and "our".
          </Info>
        </span>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Your connection">
          {RELATIONS.map((r) => (
            <Chip key={r.id} on={relation === r.id} onClick={() => setRelation(r.id)}>
              {r.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[13.5px] font-medium">
          Link to the source{" "}
          <Info label="About the source link">
            Each post links to what it's about: at the end of the post, and on LinkedIn in the first comment (a link in the post hides its image). On X, an X post's link shows it as a quote. X posts with a link are always Post it myself (free).
          </Info>
        </span>
        <Switch label="Link to the source" on={linkSource} onChange={setLinkSource} />
      </div>
      <label htmlFor={`${passion.id}-xHandles`}>
        <span className="flex items-center gap-1.5">
          X accounts{" "}
          <Info label="About X accounts">
            The organisations in it, up to 10, separated by commas. An X post may mention the one it's about, once. Their posts always count as on-topic, and their names help spot related news. X posts with a mention are always Post it myself (free).
          </Info>
        </span>
        <input id={`${passion.id}-xHandles`} name="xHandles" maxLength={400} defaultValue={passion.xHandles.map((h) => `@${h}`).join(", ")} placeholder="@name, @another" />
      </label>
      <label htmlFor={`${passion.id}-topics`}>
        <span className="flex items-center gap-1.5">
          Topics{" "}
          <Info label="About topics">
            Optional words and names that mean a new item is about it, up to 20, separated by commas. Showrium also judges each item by its meaning, so you don't need every word; add the ones its sources use that its name doesn't cover.
          </Info>
        </span>
        <input id={`${passion.id}-topics`} name="topics" maxLength={900} defaultValue={passion.topics.join(", ")} placeholder="Words or names, separated by commas" />
      </label>
      <label htmlFor={`${passion.id}-about`}>
        <span className="flex items-center gap-1.5">
          Your angle <Info label="About your angle">Why you care, or your connection to it. The writer uses it to sound like you.</Info>
        </span>
        <input id={`${passion.id}-about`} name="about" maxLength={300} defaultValue={passion.about} placeholder="e.g. I run a stake pool and teach newcomers" />
      </label>
      <label htmlFor={`${passion.id}-disclosure`}>
        <span className="flex items-center gap-1.5">
          Disclosure <Info label="About disclosure">Optional. Added word for word to the end of every post about it. If you're paid or rewarded for posting, platform rules and advertising law require one.</Info>
        </span>
        <input id={`${passion.id}-disclosure`} name="disclosure" maxLength={120} defaultValue={passion.disclosure} placeholder="e.g. I'm a Cardano ambassador" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          From
          <input type="date" name="startsOn" defaultValue={passion.startsOn ?? ""} />
        </label>
        <label htmlFor={`${passion.id}-endsOn`}>
          <span className="flex items-center gap-1.5">
            Until <Info label="About dates">Optional. Outside these dates its sources aren't checked and automation skips it.</Info>
          </span>
          <input id={`${passion.id}-endsOn`} type="date" name="endsOn" defaultValue={passion.endsOn ?? ""} />
        </label>
      </div>
      {error && <Alert>{error}</Alert>}
      <div>
        <Button disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      </div>
    </form>
  );
}

function PassionCard({ passion, sourcesEach, onChange }: { passion: Passion; sourcesEach: number; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const full = passion.sources.length >= sourcesEach;
  const toggle = async (on: boolean) => {
    setError(null);
    try {
      await api(`/passions/${passion.id}`, { method: "PATCH", body: JSON.stringify({ active: on }) });
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change it.");
    }
  };
  const remove = async () => {
    if (!window.confirm(`Remove ${passion.name}? Its sources stop being watched. Posts already written stay.`)) return;
    setError(null);
    try {
      await api(`/passions/${passion.id}`, { method: "DELETE" });
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove it.");
    }
  };
  const status = !passion.active ? "Off" : passion.live ? "On" : passion.startsOn && passion.startsOn > new Date().toISOString().slice(0, 10) ? `From ${passion.startsOn}` : "Ended";
  return (
    <Panel
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{passion.name}</span>
          <Badge tone={passion.live ? "ok" : "neutral"}>{status}</Badge>
          <span className="text-[12.5px] font-normal text-muted">{RELATIONS.find((r) => r.id === passion.relation)?.label}</span>
        </span>
      }
      action={<Switch label={`${passion.name} on`} on={passion.active} onChange={(v) => void toggle(v)} />}
    >
      {(passion.about || passion.disclosure) && !editing && (
        <p className="m-0 text-[13.5px] text-ink-2">
          {passion.about}
          {passion.disclosure && <span className="block text-muted">“{passion.disclosure}”</span>}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" icon="edit" onClick={() => setEditing((e) => !e)}>{editing ? "Close" : "Details"}</Button>
        <Button variant="ghost" size="sm" onClick={() => void remove()} aria-label={`Remove ${passion.name}`}><Icon name="trash" size={16} /></Button>
      </div>
      {editing && <Details passion={passion} onSaved={() => { setEditing(false); onChange(); }} />}
      {error && <Alert>{error}</Alert>}
      <span className="text-[13px] font-semibold text-muted">Sources ({passion.sources.length} of {sourcesEach})</span>
      {passion.sources.length > 0 && <ul className="m-0 list-none p-0">{passion.sources.map((s) => <SourceRow key={s.id} s={s} onRemoved={onChange} />)}</ul>}
      {notice && <Alert tone="ok">{notice}</Alert>}
      <AddSource passion={passion} full={full} onAdded={(n) => { setNotice(n); onChange(); }} />
    </Panel>
  );
}

export function PassionsPage() {
  const list = useApi<List>("/passions");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passions = list.data?.data ?? [];
  const limit = list.data?.limits.passions;
  const full = limit !== undefined && passions.length >= limit;

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      await api("/passions", { method: "POST", body: JSON.stringify({ name }) });
      form.reset();
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add it.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Passions"
        actions={
          <span className="flex items-center gap-2">
            {limit !== undefined && <Badge>{passions.length} of {limit}</Badge>}
            <Info label="About passions">Subjects you care about and post on, like a project or an ecosystem. Each has its own sources; new items become ideas, written as your view, never as its official voice.</Info>
          </span>
        }
      />
      {list.error && <Alert>{list.error}</Alert>}
      <Panel>
        <form onSubmit={create} className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1">
            New passion
            <input name="name" required maxLength={60} disabled={full} placeholder={full ? "Your plan's passions are in use" : "e.g. Cardano, AI, open source"} />
          </label>
          <Button disabled={busy || full} icon="plus">{busy ? "Adding…" : "Add"}</Button>
        </form>
        {full && <a href="/app/billing" className="text-sm">More passions on other plans →</a>}
        {error && <Alert>{error}</Alert>}
      </Panel>
      {list.data && passions.length === 0 && <Empty icon="heart" title="No passions yet" body="Add one above, then give it a few sources." />}
      <div className="flex flex-col gap-5">
        {passions.map((p) => (
          <PassionCard key={p.id} passion={p} sourcesEach={list.data!.limits.sourcesEach} onChange={() => list.reload()} />
        ))}
      </div>
    </>
  );
}
