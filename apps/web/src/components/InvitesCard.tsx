import { useState, type FormEvent } from "react";
import { api, formatDate, useApi } from "../lib";

type Invite = { id: string; note: string | null; status: "pending" | "accepted" | "revoked" | "expired"; expiresAt: string; createdAt: string };

// Shown only to platform admins (Showrium staff). The server enforces this too.
export function InvitesCard() {
  const invites = useApi<{ data: Invite[] }>("/admin/invites");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const formEl = e.currentTarget;
    const note = String(new FormData(formEl).get("inviteNote") ?? "");
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ link: string }>("/admin/invites", { method: "POST", body: JSON.stringify(note ? { note } : {}) });
      setLink(created.link);
      setCopied(false);
      formEl.reset();
      invites.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the invite.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api(`/admin/invites/${id}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke the invite.");
    }
    invites.reload();
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="card" aria-labelledby="invites-title">
      <h3 id="invites-title">Invites</h3>
      <p className="note">Each link works once, for 7 days, with any sign-in email. Visible to Showrium staff only.</p>
      <form className="row" onSubmit={create}>
        <label>
          Note (optional)
          <input id="inviteNote" name="inviteNote" maxLength={120} placeholder="e.g. Kemi, design partner" />
        </label>
        <button className="button" disabled={busy}>{busy ? "Creating…" : "Create invite link"}</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {link && (
        <div className="form">
          <p className="note">Send this link now. You won't be able to see it again.</p>
          <div className="secret">{link}</div>
          <button className="button secondary" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Note</th>
              <th>Status</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.data?.data.map((i) => (
              <tr key={i.id}>
                <td>{i.note ?? <span className="muted">—</span>}</td>
                <td className="muted">{i.status}</td>
                <td className="muted">{formatDate(i.expiresAt)}</td>
                <td className="num">
                  {i.status === "pending" && (
                    <button className="button danger" onClick={() => revoke(i.id)}>Revoke</button>
                  )}
                </td>
              </tr>
            ))}
            {invites.data?.data.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">No invites yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
