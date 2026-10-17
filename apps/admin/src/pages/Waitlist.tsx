// The waitlist, and a one-click invite that emails each person a single-use link to their own
// account and workspace (Free plan). Below it: invite links for people who aren't on the list.
import { type FormEvent, useMemo, useState } from "react";
import { api, Button, date as formatDate, Info, Panel, Tag, useLoad } from "../ui";

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`rounded-full border px-3 py-1 text-[13px] font-medium ${on ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong bg-panel text-ink-2 hover:bg-raised"}`}>
      {children}
    </button>
  );
}

type Status = "waiting" | "invited" | "invite_expired" | "joined";
type Entry = { id: string; email: string; source: string; joinedListAt: string; invitedAt: string | null; status: Status; joinedAt: string | null };
type Result = { id: string; email: string; sent: boolean; link: string | null };

const LABELS: Record<Status, string> = { waiting: "Waiting", invited: "Invited", invite_expired: "Invite expired", joined: "Joined" };
const TONES: Record<Status, string> = {
  waiting: "bg-raised text-ink-2",
  invited: "bg-info-soft text-info",
  invite_expired: "bg-warn-soft text-warn",
  joined: "bg-ok-soft text-ok",
};

export function Waitlist() {
  return (
    <div className="flex flex-col gap-5">
      <WaitlistPanel />
      <InviteLinks />
    </div>
  );
}

type Invite = { id: string; note: string | null; status: "pending" | "accepted" | "revoked" | "expired"; expiresAt: string; createdAt: string };
const INVITE_TONES = { pending: "info", accepted: "ok", revoked: "neutral", expired: "warn" } as const;
const INVITE_LABELS = { pending: "Waiting", accepted: "Used", revoked: "Revoked", expired: "Expired" } as const;

function InviteLinks() {
  const invites = useLoad<{ data: Invite[] }>("/invites");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const note = String(new FormData(form).get("note") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ link: string }>("/invites", { method: "POST", body: JSON.stringify(note ? { note } : {}) });
      setLink(out.link);
      setCopied(false);
      form.reset();
      invites.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the link.");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setError(null);
    try {
      await api(`/invites/${id}/revoke`, { method: "POST", body: "{}" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke the link.");
    }
    invites.reload();
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the link and copy it yourself.");
    }
  };

  return (
    <Panel title="Invite links" info="For someone who isn't on the waitlist. Each link works once, for 7 days, and creates their own account and workspace on the Free plan. It's shown only once.">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => void create(e)}>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[13px] text-muted">
          Note
          <input name="note" maxLength={120} placeholder="e.g. Kemi, design partner" className="min-h-9 rounded-lg border border-line-strong bg-panel px-3 text-[14px] text-ink" />
        </label>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Creating…" : "Create link"}</Button>
      </form>
      {link && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-sunken p-3" role="status">
          <span className="min-w-0 flex-1 font-mono text-[12.5px] [overflow-wrap:anywhere]">{link}</span>
          <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</Button>
        </div>
      )}
      {error && <p role="alert" className="m-0 text-[13.5px] text-danger">{error}</p>}
      {invites.error && <p role="alert" className="m-0 text-[13.5px] text-danger">{invites.error}</p>}
      {invites.data?.data.length === 0 && <p className="m-0 text-[13.5px] text-muted">No links yet.</p>}
      <ul className="m-0 flex list-none flex-col p-0" aria-label="Invite links">
        {invites.data?.data.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line py-2.5 last:border-b-0">
            <span className="w-full min-w-0 text-[14px] [overflow-wrap:anywhere] sm:w-auto sm:flex-1">{i.note || <span className="text-muted">No note</span>}</span>
            <Tag tone={INVITE_TONES[i.status]}>{INVITE_LABELS[i.status]}</Tag>
            <span className="text-[12.5px] text-muted">{i.status === "pending" ? `Until ${formatDate(i.expiresAt)}` : formatDate(i.createdAt)}</span>
            {i.status === "pending" && (
              <Button onClick={() => void revoke(i.id)} aria-label={`Revoke the link${i.note ? ` for ${i.note}` : ""}`}>
                Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function WaitlistPanel() {
  const list = useLoad<{ data: Entry[] }>("/waitlist");
  const [filter, setFilter] = useState<Status | "all">("waiting");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const entries = list.data?.data ?? [];
  const counts = useMemo(() => entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.status]: (acc[e.status] ?? 0) + 1 }), {}), [entries]);
  const shown = filter === "all" ? entries : entries.filter((e) => e.status === filter || (filter === "invited" && e.status === "invite_expired"));
  const invitable = shown.filter((e) => e.status !== "joined");

  const invite = async (ids: string[]) => {
    if (!ids.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ data: Result[]; skipped: number }>("/waitlist/invite", { method: "POST", body: JSON.stringify({ ids: ids.slice(0, 50) }) });
      setResults(out.data);
      setSelected(new Set());
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the invites.");
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const copy = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(link);
    } catch {
      setError("Couldn't copy. Select the link and copy it yourself.");
    }
  };

  const unsent = results?.filter((r) => !r.sent) ?? [];
  const sentCount = (results?.length ?? 0) - unsent.length;
  return (
    <Panel
      title="Waitlist"
      info="Invite emails a single-use link, valid for 7 days. It creates the person's own account and workspace on the Free plan. Inviting again replaces an unused link."
      actions={
        invitable.length > 0 && (
          <Button variant="primary" disabled={busy || !selected.size} onClick={() => void invite([...selected])}>
            {busy ? "Sending…" : `Invite selected (${selected.size})`}
          </Button>
        )
      }
    >
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {(["waiting", "invited", "joined", "all"] as const).map((f) => (
          <Chip key={f} on={filter === f} onClick={() => { setFilter(f); setSelected(new Set()); }}>
            {f === "all" ? `All (${entries.length})` : f === "invited" ? `Invited (${(counts.invited ?? 0) + (counts.invite_expired ?? 0)})` : `${LABELS[f]} (${counts[f] ?? 0})`}
          </Chip>
        ))}
      </div>
      {!list.data && !list.error && <p className="m-0 text-[13.5px] text-muted">Loading…</p>}
      {list.error && <p role="alert" className="m-0 text-[13.5px] text-danger">{list.error}</p>}
      {invitable.length > 0 && (
        <label className="flex items-center gap-2 text-[13.5px]">
          <input type="checkbox" checked={invitable.every((e) => selected.has(e.id))} onChange={(e) => setSelected(e.target.checked ? new Set(invitable.slice(0, 50).map((x) => x.id)) : new Set())} />
          Select all{invitable.length > 50 ? " (first 50)" : ""}
        </label>
      )}
      {shown.length === 0 && list.data && <p className="m-0 text-[13.5px] text-muted">Nobody here.</p>}
      <ul className="m-0 flex list-none flex-col p-0" aria-label="Waitlist">
        {shown.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line py-2.5 last:border-b-0">
            {e.status !== "joined" && <input type="checkbox" aria-label={`Select ${e.email}`} checked={selected.has(e.id)} onChange={() => toggle(e.id)} />}
            <span className="w-full min-w-0 text-[14px] font-medium [overflow-wrap:anywhere] sm:w-auto sm:flex-1">{e.email}</span>
            <span className={`rounded-md px-2 py-0.5 text-[12px] font-semibold ${TONES[e.status]}`}>{LABELS[e.status]}</span>
            <span className="text-[12.5px] text-muted">{e.status === "joined" && e.joinedAt ? `Joined ${formatDate(e.joinedAt)}` : e.invitedAt ? `Invited ${formatDate(e.invitedAt)}` : `Since ${formatDate(e.joinedListAt)}`}</span>
            {e.status !== "joined" && (
              <Button disabled={busy} onClick={() => void invite([e.id])} aria-label={`${e.status === "waiting" ? "Invite" : "Invite again"} ${e.email}`}>
                {e.status === "waiting" ? "Invite" : "Invite again"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {results && (
        <div className="flex flex-col gap-1.5 rounded-xl bg-sunken p-3" role="status">
          <span className="flex items-center gap-1.5 text-[13.5px]">
            {sentCount} emailed{unsent.length ? `, ${unsent.length} to share yourself` : ""}
            {unsent.length > 0 && <Info>Email isn't set up or failed for these. Each link works once; copy it and send it yourself.</Info>}
          </span>
          {unsent.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-[13px] [overflow-wrap:anywhere]">{r.email}</span>
              <Button onClick={() => void copy(r.link!)}>{copied === r.link ? "Copied" : "Copy link"}</Button>
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert" className="m-0 text-[13.5px] text-danger">{error}</p>}
    </Panel>
  );
}
