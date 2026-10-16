import { useState, type FormEvent } from "react";
import type { Me } from "../App";
import { Alert, api, Button, date, Info, Panel, Tag, useLoad } from "../ui";

type Member = { id: string | null; email: string; role: "owner" | "support" | "finance"; fromSettings: boolean; acceptedAt: string | null; createdAt: string | null };
const ROLES = ["owner", "support", "finance"] as const;
const ROLE_INFO = "Owner: everything. Support: overview, waitlist and looking up accounts. Finance: overview and billing.";

export function Staff({ me }: { me: Me }) {
  const list = useLoad<{ data: Member[] }>("/staff");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("support");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  const invite = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const out = await api<{ sent: boolean; link: string | null; hasAccount: boolean }>("/staff", { method: "POST", body: JSON.stringify({ email, role }) });
      setLink(out.link);
      setEmail("");
    });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Panel title="Staff" info={ROLE_INFO}>
        {list.error && <Alert>{list.error}</Alert>}
        <ul className="m-0 flex list-none flex-col p-0">
          {list.data?.data.map((m) => (
            <li key={m.email} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line py-2.5 last:border-b-0">
              <span className="w-full min-w-0 text-[14px] font-medium [overflow-wrap:anywhere] sm:w-auto sm:flex-1">{m.email}</span>
              {m.fromSettings || !m.id || m.email === me.email ? (
                <Tag tone="info">{m.role}</Tag>
              ) : (
                <select aria-label={`Role for ${m.email}`} value={m.role} disabled={busy} onChange={(e) => void run(() => api(`/staff/${m.id}`, { method: "PATCH", body: JSON.stringify({ role: e.target.value }) }))}>
                  {ROLES.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              )}
              <span className="text-[12.5px] text-muted">{m.fromSettings ? "Owner (settings)" : m.acceptedAt ? `Active since ${date(m.acceptedAt)}` : "Invited"}</span>
              {m.id &&
                !m.fromSettings &&
                m.email !== me.email &&
                (confirm === m.id ? (
                  <span className="flex gap-1.5">
                    <Button variant="danger" disabled={busy} onClick={() => void run(async () => { await api(`/staff/${m.id}`, { method: "PATCH", body: JSON.stringify({ remove: true }) }); setConfirm(null); })}>
                      Confirm remove
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirm(null)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirm(m.id)}>
                    Remove
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Invite staff" info="If they have no Showrium account yet, they get an email with a one-time link to create one. Removing staff takes away their access; their account stays.">
        <form onSubmit={invite} className="flex flex-col gap-2">
          <input type="email" required aria-label="Email" placeholder="Email" value={email} maxLength={320} onChange={(e) => setEmail(e.target.value)} />
          <select aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <Button variant="primary" type="submit" disabled={busy || !email.includes("@")}>
            Invite
          </Button>
        </form>
        {link && (
          <div className="flex flex-col gap-1 rounded-xl bg-sunken p-3 text-[13px]" role="status">
            <span className="flex items-center gap-1.5">
              Not emailed. Share this link <Info>Works once, for 7 days.</Info>
            </span>
            <code className="break-all text-[12px]">{link}</code>
          </div>
        )}
        {error && <Alert>{error}</Alert>}
      </Panel>
    </div>
  );
}
