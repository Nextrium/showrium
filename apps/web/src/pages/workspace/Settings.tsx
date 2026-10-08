import { SecurityPanel } from "../../components/Security";
import { YourData } from "../../components/YourData";
import { ImageSettingsPanel } from "../../components/PostImage";
import { useState, type FormEvent } from "react";
import { WaitlistCard } from "../../components/WaitlistCard";
import { InvitesCard } from "../../components/InvitesCard";
import { api, authClient, formatDate, timeAgo, useApi } from "../../lib";
import { planLabel, ThemePicker } from "../../shell/AppShell";
import { Alert, Badge, Button, PageHeader, Panel } from "../../ui/kit";

type Me = { principal: { kind: string; role: string; isPlatformAdmin: boolean }; workspace: { id: string; name: string; plan: string; fullAccess: boolean } };
type ApiKey = { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };

function ApiKeys({ canManage }: { canManage: boolean }) {
  const keys = useApi<{ data: ApiKey[] }>("/api-keys");
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("keyName"));
    setBusy(true);
    setError(null);
    try {
      setNewKey(await api<{ name: string; key: string }>("/api-keys", { method: "POST", body: JSON.stringify({ name }) }));
      setCopied(false);
      form.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the key.");
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (k: ApiKey) => {
    if (!window.confirm(`Revoke “${k.name}”? Anything using it stops working immediately.`)) return;
    try {
      await api(`/api-keys/${k.id}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke the key.");
    }
  };

  return (
    <Panel title="API keys" id="keys">
      <p className="m-0 text-sm text-muted">
        For developers and AI agents. Call the <a href="/api/docs">Showrium API</a> with <code>Authorization: Bearer &lt;key&gt;</code>, or connect an agent to the MCP server at <code>{window.location.origin}/api/mcp</code>.
      </p>
      {canManage && (
        <form className="flex flex-wrap items-end gap-2.5" onSubmit={create}>
          <label className="min-w-[200px] flex-1">
            Key name
            <input name="keyName" required maxLength={60} placeholder="e.g. Production server" />
          </label>
          <Button disabled={busy}>{busy ? "Creating…" : "Create key"}</Button>
        </form>
      )}
      {error && <Alert>{error}</Alert>}
      {newKey && (
        <div className="flex flex-col gap-2 rounded-2xl border border-accent bg-accent-soft p-4">
          <span className="text-sm">Copy <strong>{newKey.name}</strong> now. You won’t see it again.</span>
          <div className="secret">{newKey.key}</div>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={async () => {
              await navigator.clipboard.writeText(newKey.key).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy key"}
          </Button>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Key</th><th>Last used</th><th><span className="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            {keys.data?.data.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td><code>{k.prefix}…</code></td>
                <td className="text-muted">{k.revokedAt ? "Revoked" : k.lastUsedAt ? timeAgo(k.lastUsedAt) : "Never"}</td>
                <td className="num">{!k.revokedAt && canManage && <Button variant="danger" size="sm" onClick={() => revoke(k)}>Revoke</Button>}</td>
              </tr>
            ))}
            {keys.data?.data.length === 0 && <tr><td colSpan={4} className="text-muted">No keys yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

type Grant = { id: string; name: string; note: string | null; at: string | null };
type Found = { id: string; name: string; plan: string; fullAccess: boolean; role: string };

/** Staff only: give full access to specific workspaces (yours, testers, partners). Audited in each workspace. */
function AccessGrants() {
  const grants = useApi<{ data: Grant[] }>("/admin/access");
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const search = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email")).trim();
    setError(null);
    try {
      const out = await api<{ data: Found[] }>(`/admin/orgs?email=${encodeURIComponent(email)}`);
      setFound(out.data);
      if (!out.data.length) setError("No account with that email.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    }
  };
  const setAccess = async (id: string, full: boolean) => {
    if (note.trim().length < 3) {
      setError("Add a short note first (why), for the audit log.");
      return;
    }
    setError(null);
    try {
      await api(`/admin/orgs/${id}/access`, { method: "PUT", body: JSON.stringify({ full, note: note.trim() }) });
      setFound((f) => f?.map((w) => (w.id === id ? { ...w, fullAccess: full } : w)) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change access.");
    }
  };

  return (
    <Panel title="Full access" id="grants">
      <p className="m-0 text-sm text-muted">Workspaces with full access skip plan limits (still capped for cost safety). Everyone else stays on their plan. Each change is recorded in that workspace’s audit log.</p>
      <form className="flex flex-wrap items-end gap-2.5" onSubmit={search}>
        <label className="min-w-[220px] flex-1">
          Find a person by email
          <input name="email" type="email" required placeholder="name@example.com" />
        </label>
        <Button variant="secondary">Find</Button>
      </form>
      <label>
        Note (why)
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Beta tester, Nextrium team" />
      </label>
      {error && <Alert>{error}</Alert>}
      {found?.map((w) => (
        <div key={w.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-sunken p-3">
          <span className="min-w-0 flex-1 truncate text-sm"><strong>{w.name}</strong> <span className="text-muted">· {w.role} · {planLabel(w.plan, w.fullAccess)}</span></span>
          {w.fullAccess ? <Button variant="danger" size="sm" onClick={() => setAccess(w.id, false)}>Remove full access</Button> : <Button size="sm" onClick={() => setAccess(w.id, true)}>Give full access</Button>}
        </div>
      ))}
      <span className="text-sm font-semibold">Current grants</span>
      {grants.data?.data.length === 0 && <span className="text-sm text-muted">None yet.</span>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {grants.data?.data.map((g) => (
          <li key={g.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{g.name}</span>
            <span className="text-muted">{g.note}{g.at ? ` · ${formatDate(g.at)}` : ""}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function SettingsPage() {
  const { data: me } = useApi<Me>("/me");
  const { data: session } = authClient.useSession();
  const canManage = me?.principal.role === "owner" || me?.principal.role === "admin";
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Appearance, security, images, your data and developer access."
        actions={me && <Badge tone={me.workspace.fullAccess ? "info" : "neutral"}>{me.workspace.name} · {planLabel(me.workspace.plan, me.workspace.fullAccess)}</Badge>}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Appearance" id="appearance">
          <p className="m-0 text-sm text-muted">Choose a theme, or follow your device. Saved in this browser.</p>
          <ThemePicker />
        </Panel>
        <ApiKeys canManage={canManage} />
        <SecurityPanel />
        <ImageSettingsPanel canManage={canManage} />
        {session?.user.email && <YourData canExport={canManage} email={session.user.email} />}
      </div>
      {me?.principal.isPlatformAdmin && (
        <>
          <h2 className="mt-2 font-sans text-base font-semibold tracking-normal text-muted">Showrium staff</h2>
          <div className="grid gap-5 lg:grid-cols-2">
            <AccessGrants />
            <InvitesCard />
            <WaitlistCard />
          </div>
        </>
      )}
    </>
  );
}
