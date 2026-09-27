import { useEffect, useState } from "react";
import { api, authClient, useApi } from "../lib";

type Config = { auth: { github: boolean; google: boolean } };

export function Invite() {
  const { data: config } = useApi<Config>("/config");
  // Read once at first render (effects may run twice in development).
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token"));
  const [state, setState] = useState<"checking" | "valid" | "invalid">("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Remove the token from the address bar and history as soon as it's read.
    window.history.replaceState(null, "", "/invite");
    if (!token) {
      setState("invalid");
      return;
    }
    api("/invites/accept", { method: "POST", body: JSON.stringify({ token }) })
      .then(() => setState("valid"))
      .catch((e: unknown) => {
        setState("invalid");
        setError(e instanceof Error ? e.message : null);
      });
  }, [token]);

  const social = async (provider: "github" | "google") => {
    const { error } = await authClient.signIn.social({ provider, callbackURL: "/app", errorCallbackURL: "/signin" });
    if (error) setError(error.message ?? "Couldn't start sign-in. Please try again.");
  };

  return (
    <section className="auth">
      <h2>{state === "invalid" ? "This invite link doesn't work" : "You're invited to Showrium"}</h2>
      {state === "checking" && <p className="note">Checking your invite…</p>}
      {state === "valid" && (
        <>
          <p className="note">Sign in to create your account. Your invite works with any email. It's valid for the next 30 minutes on this device.</p>
          {config?.auth.github && (
            <button className="button" onClick={() => social("github")}>
              Continue with GitHub
            </button>
          )}
          {config?.auth.google && (
            <button className="button secondary" onClick={() => social("google")}>
              Continue with Google
            </button>
          )}
          {config && !config.auth.github && !config.auth.google && (
            <a className="button" href="/signin">
              Continue to sign up
            </a>
          )}
        </>
      )}
      {state === "invalid" && (
        <p className="error" role="alert">
          {error ?? "This invite link is invalid, already used or expired."} The person who invited you can send a new one.
        </p>
      )}
    </section>
  );
}
