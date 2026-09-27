import { useEffect, useState } from "react";
import { api, authClient, switchWorkspace, useApi } from "../lib";

type Config = { auth: { github: boolean; google: boolean } };
type Preview = { workspace: string; role: string; emailHint: string };
const KEY = "showrium_team_invite";

/** Team invitation: /join?token=… Works for people with or without an account. */
export function Join() {
  const { data: session, isPending } = authClient.useSession();
  const { data: config } = useApi<Config>("/config");
  // The token survives the sign-in round trip in this tab only, and leaves the address bar at once.
  const [token] = useState(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    try {
      if (fromUrl) sessionStorage.setItem(KEY, fromUrl);
      return fromUrl ?? sessionStorage.getItem(KEY);
    } catch {
      return fromUrl;
    }
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.history.replaceState(null, "", "/join");
    if (!token) return setError("This invitation link is incomplete.");
    api<Preview>("/team-invites/preview", { method: "POST", body: JSON.stringify({ token }) })
      .then(setPreview)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "This invitation doesn't work."));
  }, [token]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api<{ orgId: string }>("/team-invites/accept", { method: "POST", body: JSON.stringify({ token }) });
      try {
        sessionStorage.removeItem(KEY);
      } catch {
        // ignore
      }
      switchWorkspace(out.orgId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't join.");
      setBusy(false);
    }
  };
  const social = async (provider: "github" | "google") => {
    const { error } = await authClient.signIn.social({ provider, callbackURL: "/join", errorCallbackURL: "/signin" });
    if (error) setError(error.message ?? "Couldn't start sign-in.");
  };

  return (
    <section className="auth">
      <h2>{preview ? `Join ${preview.workspace}` : "Team invitation"}</h2>
      {preview && <p className="note">You're invited as {preview.role}. This invitation is for {preview.emailHint}.</p>}
      {preview && !isPending && session && (
        <>
          <p className="note">Signed in as {session.user.email}.</p>
          <button className="button" disabled={busy} onClick={accept}>{busy ? "Joining…" : "Join the workspace"}</button>
        </>
      )}
      {preview && !isPending && !session && (
        <>
          <p className="note">Sign in with the invited email to join. No account yet? Signing in creates one.</p>
          {config?.auth.github && <button className="button" onClick={() => social("github")}>Continue with GitHub</button>}
          {config?.auth.google && <button className="button secondary" onClick={() => social("google")}>Continue with Google</button>}
          {config && !config.auth.github && !config.auth.google && <a className="button" href="/signin">Continue to sign in</a>}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
