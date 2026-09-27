import { useState, type FormEvent } from "react";
import { AuditCard, BillingCard, TeamCard } from "../components/BusinessCards";
import { InvitesCard } from "../components/InvitesCard";
import { api, authClient, formatDate, navigate, useApi, useRedirect } from "../lib";

type Me = { principal: { kind: string; role: string; isPlatformAdmin: boolean }; workspace: { id: string; name: string; plan: string } };
type Credits = { balance: number; transactions: { id: string; kind: string; description: string; amount: number; createdAt: string }[] };
type ApiKey = { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };

export function Dashboard() {
  const { data: session, isPending } = authClient.useSession();
  const me = useApi<Me>("/me");
  const credits = useApi<Credits>("/credits");
  const keys = useApi<{ data: ApiKey[] }>("/api-keys");
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);

  const signedOut = !isPending && !session;
  useRedirect("/signin", signedOut);
  if (signedOut) return null;
  if (!me.data) return <p className="note">{me.error ?? "Loading your workspace…"}</p>;

  const canManageKeys = me.data.principal.role === "owner" || me.data.principal.role === "admin";

  const createKey = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const name = String(new FormData(formEl).get("keyName"));
    if (creating) return;
    setKeyError(null);
    setCreating(true);
    try {
      const created = await api<{ name: string; key: string }>("/api-keys", { method: "POST", body: JSON.stringify({ name }) });
      setNewKey(created);
      setCopied(false);
      formEl.reset();
      keys.reload();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Couldn't create the key.");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api(`/api-keys/${id}`, { method: "DELETE" });
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Couldn't revoke the key.");
    }
    keys.reload();
  };

  const copy = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <span className="eyebrow">{me.data.workspace.plan} plan</span>
          <h2>{me.data.workspace.name}</h2>
        </div>
        <button
          className="button secondary"
          onClick={async () => {
            await authClient.signOut();
            navigate("/");
          }}
        >
          Sign out
        </button>
      </div>

      <div className="grid2">
        <section className="card" aria-labelledby="credits-title">
          <h3 id="credits-title">Credits</h3>
          <div className="stat">{credits.data?.balance ?? "–"}</div>
          <p className="note">1 credit = $0.01. Credits pay for extras like X posts with links and avatar videos.</p>
          <div className="table-wrap">
            <table>
              <tbody>
                {credits.data?.transactions.map((t) => (
                  <tr key={t.id}>
                    <td>{t.description}</td>
                    <td className="muted">{formatDate(t.createdAt)}</td>
                    <td className={`num ${t.amount > 0 ? "plus" : ""}`}>{t.amount > 0 ? `+${t.amount}` : t.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="keys-title">
          <h3 id="keys-title">API keys</h3>
          <p className="note">
            For developers: call the <a href="/api/docs">Showrium API</a> with{" "}
            <code>Authorization: Bearer &lt;key&gt;</code>.
          </p>
          {canManageKeys && (
            <form className="row" onSubmit={createKey}>
              <label>
                Key name
                <input id="keyName" name="keyName" required maxLength={60} placeholder="e.g. Production server" />
              </label>
              <button className="button" disabled={creating}>{creating ? "Creating…" : "Create key"}</button>
            </form>
          )}
          {keyError && <p className="error" role="alert">{keyError}</p>}
          {newKey && (
            <div className="form">
              <p className="note">
                Copy <strong>{newKey.name}</strong> now. You won't be able to see it again.
              </p>
              <div className="secret">{newKey.key}</div>
              <button className="button secondary" onClick={copy}>
                {copied ? "Copied" : "Copy key"}
              </button>
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.data?.data.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td><code>{k.prefix}…</code></td>
                    <td className="muted">{k.revokedAt ? "Revoked" : k.lastUsedAt ? formatDate(k.lastUsedAt) : "Never"}</td>
                    <td className="num">
                      {!k.revokedAt && canManageKeys && (
                        <button className="button danger" onClick={() => revoke(k.id)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {keys.data?.data.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">No keys yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="grid2">
        <BillingCard canManage={canManageKeys} />
        <TeamCard canManage={canManageKeys} myEmail={session?.user.email ?? ""} />
      </div>
      {canManageKeys && <AuditCard />}

      {me.data.principal.isPlatformAdmin && <InvitesCard />}

    </div>
  );
}
