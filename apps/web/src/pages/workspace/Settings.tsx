import { SecurityPanel } from "../../components/Security";
import { YourData } from "../../components/YourData";
import { ImageSettingsPanel } from "../../components/PostImage";
import { useState, type FormEvent } from "react";
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
    </>
  );
}
