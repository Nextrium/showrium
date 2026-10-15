import { useState, type FormEvent } from "react";
import { api, authClient, orgHeaders } from "../lib";
import { Alert, Button, Panel } from "../ui/kit";

/** Settings → Your data: download a copy, or delete the account (privacy rights). */
export function YourData({ canExport, email }: { canExport: boolean; email: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const download = async () => {
    setBusy("export");
    setError(null);
    try {
      const res = await fetch("/api/v1/export", { headers: orgHeaders() });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message: string } } | null)?.error?.message ?? "Couldn't prepare the download.");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `showrium-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't prepare the download.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const confirmEmail = String(new FormData(e.currentTarget).get("confirmEmail") ?? "");
    setBusy("delete");
    setError(null);
    try {
      await api("/account/delete", { method: "POST", body: JSON.stringify({ confirmEmail }) });
      await authClient.signOut().catch(() => undefined);
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the account.");
      setBusy(null);
    }
  };

  return (
    <Panel title="Your data" id="your-data">
      <p className="m-0 text-sm text-muted">Your posts, material and settings belong to you. Download a copy any time, or delete your account.</p>
      {canExport && (
        <Button variant="secondary" className="self-start" disabled={Boolean(busy)} onClick={download}>
          {busy === "export" ? "Preparing…" : "Download this workspace's data"}
        </Button>
      )}
      {!confirming ? (
        <Button variant="danger" className="self-start" onClick={() => setConfirming(true)}>Delete my account</Button>
      ) : (
        <form onSubmit={remove} className="flex flex-col gap-3 rounded-xl border border-danger/40 bg-danger-soft/40 p-4">
          <p className="m-0 text-sm text-ink-2">
            This deletes your account and every workspace where you're the only member, with all posts, material, images and connected accounts. It can't be undone. Payment records are kept by the payment provider, as the law requires.
          </p>
          <label>
            Type your email ({email}) to confirm
            <input name="confirmEmail" type="email" required autoComplete="off" />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" disabled={Boolean(busy)}>{busy === "delete" ? "Deleting…" : "Delete everything"}</Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>Keep my account</Button>
          </div>
        </form>
      )}
      {error && <Alert>{error}</Alert>}
    </Panel>
  );
}
