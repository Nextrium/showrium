import { useState, type FormEvent } from "react";
import { api, formatDate, useApi } from "../lib";

type Item = { kind: "plan"; plan: string; interval: "month" | "year" } | { kind: "credits"; pack: "c500" | "c1100" };
type Billing = {
  plan: string;
  features: { autopilot: string; insights: boolean; seats: number };
  subscription: { provider: string; plan: string; interval: string; status: string; currentPeriodEnd: string | null } | null;
  catalog: { item: Item; usdCents: number; providers: ("paystack" | "lemonsqueezy")[] }[];
};
const PROVIDER = { paystack: "Pay in naira (Paystack)", lemonsqueezy: "Pay by card, worldwide" };
const PACK = { c500: "500 credits", c1100: "1,100 credits" };
const usd = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const msg = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

export function BillingCard({ canManage }: { canManage: boolean }) {
  const { data } = useApi<Billing>("/billing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = new URLSearchParams(window.location.search).get("billing") === "done";
  if (!data) return null;

  const go = async (path: string, payload?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ url: string }>(path, { method: "POST", ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (!out.url.startsWith("https://")) throw new Error("Unexpected payment link.");
      window.location.assign(out.url); // the provider's own checkout page
    } catch (err) {
      setError(msg(err, "Couldn't open the payment page."));
      setBusy(false);
    }
  };
  const sub = data.subscription;
  const active = sub && (sub.status === "active" || sub.status === "past_due" || sub.status === "cancelled");
  const plans = data.catalog.filter((c) => c.item.kind === "plan" && c.providers.length);
  const packs = data.catalog.filter((c) => c.item.kind === "credits" && c.providers.length);

  return (
    <section className="card" aria-labelledby="billing-title">
      <h3 id="billing-title">Plan and billing</h3>
      <p className="note">
        You're on <strong>{data.plan}</strong>: autopilot up to "{data.features.autopilot}", audience themes {data.features.insights ? "included" : "not included"}, {data.features.seats} seat{data.features.seats === 1 ? "" : "s"}.
      </p>
      {done && <p className="note" role="status">Thanks! Your payment is being confirmed; this page updates within a minute.</p>}
      {sub && active && (
        <p className="note">
          {sub.plan} ({sub.interval}ly) via {sub.provider}: {sub.status === "cancelled" ? "cancelled, ends" : sub.status === "past_due" ? "payment failed, retrying until" : "renews"} {sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : "soon"}.
        </p>
      )}
      {canManage && active && <button className="button secondary" disabled={busy} onClick={() => go("/billing/portal")}>Manage billing</button>}
      {canManage && !active && plans.length > 0 && (
        <div className="table-wrap">
          <table>
            <tbody>
              {plans.map((c) => (
                <tr key={`${c.item.kind === "plan" && c.item.plan}-${c.item.kind === "plan" && c.item.interval}`}>
                  <td>{c.item.kind === "plan" && c.item.plan} <span className="muted">{usd(c.usdCents)}/{c.item.kind === "plan" && c.item.interval}</span></td>
                  <td className="num">{c.providers.map((p) => <button key={p} className="button secondary" disabled={busy} onClick={() => go("/billing/checkout", { provider: p, item: c.item })}>{PROVIDER[p]}</button>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canManage && packs.length > 0 && (
        <>
          <p className="note">Credit packs (never expire):</p>
          <div className="row">
            {packs.flatMap((c) => c.providers.map((p) => (
              <button key={`${c.item.kind === "credits" && c.item.pack}-${p}`} className="button secondary" disabled={busy} onClick={() => go("/billing/checkout", { provider: p, item: c.item })}>
                {c.item.kind === "credits" && PACK[c.item.pack]} · {usd(c.usdCents)} · {p === "paystack" ? "naira" : "card"}
              </button>
            )))}
          </div>
        </>
      )}
      {!plans.length && !packs.length && <p className="note">Paid plans open soon. During the beta, ask us if you need more.</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

type Team = { seats: number; members: { id: string; name: string; email: string; role: string }[]; invites: { id: string; email: string; role: string; expiresAt: string }[] };
const ROLES = ["viewer", "editor", "approver", "admin", "owner"];

export function TeamCard({ canManage, myEmail }: { canManage: boolean; myEmail: string }) {
  const { data, reload } = useApi<Team>("/team");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setError(msg(err, "That didn't work."));
    }
  };
  const invite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    return run(async () => {
      const out = await api<{ link: string }>("/team/invites", { method: "POST", body: JSON.stringify({ email: f.get("email"), role: f.get("role") }) });
      setLink(out.link);
      form.reset();
    });
  };
  const used = data.members.length + data.invites.length;
  const owners = data.members.filter((m) => m.role === "owner").length;
  // The last owner can't leave or be removed (the server refuses too).
  const removable = (m: Team["members"][number]) => !(m.role === "owner" && owners <= 1) && (canManage || m.email === myEmail);

  return (
    <section className="card" aria-labelledby="team-title">
      <h3 id="team-title">Team</h3>
      <p className="note">{used} of {data.seats} seat{data.seats === 1 ? "" : "s"} used. Roles: viewers read; editors write; approvers approve and publish; admins manage everything but owners.</p>
      <div className="table-wrap">
        <table>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id}>
                <td>{m.name} <span className="muted">{m.email}</span></td>
                <td>
                  {canManage && m.email !== myEmail ? (
                    <select aria-label={`Role for ${m.email}`} value={m.role} onChange={(e) => run(() => api(`/team/members/${m.id}`, { method: "PATCH", body: JSON.stringify({ role: e.target.value }) }))}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                <td className="num">
                  {removable(m) && (
                    <button className="button danger" onClick={() => run(() => api(`/team/members/${m.id}`, { method: "DELETE" }))}>{m.email === myEmail ? "Leave" : "Remove"}</button>
                  )}
                </td>
              </tr>
            ))}
            {data.invites.map((i) => (
              <tr key={i.id}>
                <td>{i.email} <span className="muted">invited until {formatDate(i.expiresAt)}</span></td>
                <td>{i.role}</td>
                <td className="num">{canManage && <button className="button danger" onClick={() => run(() => api(`/team/invites/${i.id}`, { method: "DELETE" }))}>Revoke</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canManage && used < data.seats && (
        <form className="row" onSubmit={invite}>
          <label>Email<input name="email" type="email" required maxLength={320} /></label>
          <label>Role<select name="role" defaultValue="editor">{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
          <button className="button">Invite</button>
        </form>
      )}
      {link && (
        <div className="form">
          <p className="note">Send this link to them (shown once, valid 7 days, only works for that email):</p>
          <div className="secret">{link}</div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

type Audit = { data: { id: string; action: string; target: string | null; actor: string | null; createdAt: string }[] };

export function AuditCard() {
  const [before, setBefore] = useState<string | undefined>(undefined);
  const { data } = useApi<Audit>(`/audit${before ? `?before=${encodeURIComponent(before)}` : ""}`);
  if (!data) return null;
  const last = data.data[data.data.length - 1];
  return (
    <section className="card" aria-labelledby="audit-title">
      <h3 id="audit-title">Audit log</h3>
      <div className="table-wrap">
        <table>
          <tbody>
            {data.data.map((a) => (
              <tr key={a.id}>
                <td>{a.action}</td>
                <td className="muted">{a.actor}</td>
                <td className="muted">{new Date(a.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        {before && <button className="button secondary" onClick={() => setBefore(undefined)}>Newest</button>}
        {data.data.length === 50 && last && <button className="button secondary" onClick={() => setBefore(last.id)}>Older</button>}
      </div>
    </section>
  );
}
