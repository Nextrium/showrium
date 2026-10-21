import { useState, type FormEvent } from "react";
import type { Me } from "../App";
import { Alert, api, Button, date, Info, KIND_NAMES, KIND_TONES, Panel, PLAN_NAMES, Tag, useLoad } from "../ui";

type Found = { id: string; name: string; email: string; verified: boolean; createdAt: string };
type Workspace = {
  id: string;
  name: string;
  plan: string;
  fullAccess: boolean;
  kind: keyof typeof KIND_TONES;
  role: string;
  personal: boolean;
  usage: { postsGenerated: number; videosRendered: number; xApiPosts: number; researchRuns: number };
  subscription: { status: string; plan: string; provider: string } | null;
};
type Detail = Found & { twoFactor: boolean; workspaces: Workspace[] };
type Kind = keyof typeof KIND_TONES;
type KindRow = {
  id: string;
  name: string;
  plan: string;
  kind: Kind;
  owner: string | null;
  subscription: { status: string; provider: string } | null;
  given: { by: string | null; note: string | null; at: string | null } | null;
};
const KINDS: Kind[] = ["paying", "granted", "full_access", "free"];
const kindFromUrl = (): Kind => {
  const k = new URLSearchParams(window.location.search).get("kind");
  return (KINDS as string[]).includes(k ?? "") ? (k as Kind) : "granted";
};

/** One group of workspaces (paying, granted, full access or free), with who gave access and why. */
function ByKind({ onOwner }: { onOwner: (email: string) => void }) {
  const [kind, setKind] = useState<Kind>(kindFromUrl);
  const list = useLoad<{ data: KindRow[] }>(`/workspaces?kind=${kind}`);
  return (
    <Panel title="Workspaces by access" info="Paying: a subscription still in force. Granted plan: a plan above Free given by staff, with no paying subscription. Full access: given by staff. Granted plans and full access bring no revenue.">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind of workspace">
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-[13px] ${kind === k ? "border-transparent bg-[var(--selected)] font-semibold text-ink" : "border-line bg-transparent text-ink-2 hover:bg-raised"}`}>
            {KIND_NAMES[k]}
          </button>
        ))}
      </div>
      {list.error && <Alert>{list.error}</Alert>}
      {list.data && list.data.data.length === 0 && <p className="m-0 text-[13.5px] text-muted">None.</p>}
      <ul className="m-0 flex list-none flex-col p-0" aria-label={KIND_NAMES[kind]}>
        {list.data?.data.map((w) => (
          <li key={w.id} className="flex flex-col gap-1 border-b border-line py-2 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-[14px] [overflow-wrap:anywhere]">{w.name}</strong>
              <Tag tone={KIND_TONES[w.kind]}>{KIND_NAMES[w.kind]}</Tag>
              {w.kind !== "full_access" && <Tag>{PLAN_NAMES[w.plan] ?? w.plan}</Tag>}
              {w.subscription && <Tag tone={w.subscription.status === "active" ? "ok" : "warn"}>{`${w.subscription.provider}: ${w.subscription.status}`}</Tag>}
            </div>
            {w.owner && (
              <button type="button" onClick={() => onOwner(w.owner!)} className="cursor-pointer self-start border-0 bg-transparent p-0 text-left text-[13px] text-[var(--accent-ink)] underline [overflow-wrap:anywhere]">
                {w.owner}
              </button>
            )}
            {w.given && (
              <span className="text-[12.5px] text-muted [overflow-wrap:anywhere]">
                {[w.given.by && `By ${w.given.by}`, w.given.at && date(w.given.at), w.given.note].filter(Boolean).join(" · ") || "No reason recorded"}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

const PLANS = ["free", "lite", "starter", "creator", "pro", "team", "team_seats"];

function WorkspaceRow({ w, canManage, onChanged }: { w: Workspace; canManage: boolean; onChanged: () => void }) {
  const [plan, setPlan] = useState(w.plan);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNote("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-[14px]">{w.name}</strong>
        <Tag>{w.role}</Tag>
        <Tag tone={KIND_TONES[w.kind]}>{KIND_NAMES[w.kind]}</Tag>
        {!w.fullAccess && <Tag>{PLAN_NAMES[w.plan] ?? w.plan}</Tag>}
        {w.subscription && <Tag tone={w.subscription.status === "active" ? "ok" : "warn"}>{`${w.subscription.provider}: ${w.subscription.status}`}</Tag>}
      </div>
      <span className="text-[12.5px] text-muted">
        This month: {w.usage.postsGenerated} posts · {w.usage.videosRendered} videos · {w.usage.xApiPosts} X posts · {w.usage.researchRuns} researches
      </span>
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={`Plan for ${w.name}`} value={plan} onChange={(e) => setPlan(e.target.value)}>
            {PLANS.map((p) => (
              <option key={p} value={p}>
                {PLAN_NAMES[p]}
              </option>
            ))}
          </select>
          <input aria-label={`Reason for ${w.name}`} placeholder="Reason" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="min-w-40 flex-1" />
          <Button disabled={busy || note.trim().length < 3 || plan === w.plan} onClick={() => run(() => api(`/workspaces/${w.id}/plan`, { method: "PUT", body: JSON.stringify({ plan, note }) }))}>
            Change plan
          </Button>
          <Button disabled={busy || note.trim().length < 3} onClick={() => run(() => api(`/workspaces/${w.id}/access`, { method: "PUT", body: JSON.stringify({ full: !w.fullAccess, note }) }))}>
            {w.fullAccess ? "Remove full access" : "Give full access"}
          </Button>
          <Info>Both can be changed back at any time. A reason is required and recorded in Activity.</Info>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
    </li>
  );
}

export function Users({ me }: { me: Me }) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const found = useLoad<{ data: Found[] }>(query ? `/users?q=${encodeURIComponent(query)}` : null);
  const detail = useLoad<Detail>(openId ? `/users/${openId}` : null);
  const canManage = me.permissions.includes("users.manage");
  const search = (e: FormEvent) => {
    e.preventDefault();
    setOpenId(null);
    setQuery(q.trim());
  };
  // From the list by access: look up the owner's account.
  const findOwner = (email: string) => {
    setQ(email);
    setOpenId(null);
    setQuery(email);
  };

  return (
    <div className="flex flex-col gap-4">
    <ByKind onOwner={findOwner} />
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Panel title="Find an account">
        <form onSubmit={search} className="flex gap-2" role="search">
          <input aria-label="Email contains" placeholder="Email" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1" />
          <Button variant="primary" type="submit" disabled={q.trim().length < 2}>
            Search
          </Button>
        </form>
        {found.error && <Alert>{found.error}</Alert>}
        {found.data && found.data.data.length === 0 && <p className="m-0 text-[13.5px] text-muted">No accounts match.</p>}
        <ul className="m-0 flex list-none flex-col p-0">
          {found.data?.data.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => (openId === u.id ? detail.reload() : setOpenId(u.id))}
                aria-current={openId === u.id}
                className={`flex w-full cursor-pointer flex-col items-start gap-0.5 border-b border-line px-1 py-2 text-left last:border-b-0 hover:bg-raised ${openId === u.id ? "bg-raised" : ""}`}
              >
                <span className="text-[14px] font-medium [overflow-wrap:anywhere]">{u.email}</span>
                <span className="text-[12.5px] text-muted">
                  {u.name} · joined {date(u.createdAt)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
      {openId && (
        <Panel title="Account">
          {detail.error && <Alert>{detail.error}</Alert>}
          {detail.data && (
            <>
              <div className="flex flex-col gap-1">
                <strong className="text-[15px] [overflow-wrap:anywhere]">{detail.data.email}</strong>
                <span className="text-[13px] text-muted">
                  {detail.data.name} · joined {date(detail.data.createdAt)}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <Tag tone={detail.data.verified ? "ok" : "warn"}>{detail.data.verified ? "Email confirmed" : "Email not confirmed"}</Tag>
                  <Tag tone={detail.data.twoFactor ? "ok" : "neutral"}>{detail.data.twoFactor ? "Two-step on" : "Two-step off"}</Tag>
                </div>
              </div>
              <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Workspaces">
                {detail.data.workspaces.map((w) => (
                  <WorkspaceRow key={`${w.id}-${w.plan}-${w.fullAccess}`} w={w} canManage={canManage} onChanged={detail.reload} />
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}
    </div>
    </div>
  );
}
