import { useState, type FormEvent } from "react";
import { WaitlistForm } from "../components/WaitlistForm";
import { authClient, navigate, useApi, useRedirect } from "../lib";

type Config = { auth: { password: boolean; github: boolean; google: boolean }; signupMode: "waitlist" | "allowlist" };

export function SignIn() {
  const { data: config } = useApi<Config>("/config");
  const { data: session } = authClient.useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  // OAuth failures come back as ?error=... (e.g. an email that isn't on the beta allowlist).
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("error")
      ? "We couldn't sign you in. Showrium is invite-only right now: join the waitlist below, or email support@showrium.com."
      : null,
  );
  const [busy, setBusy] = useState(false);

  useRedirect("/app", Boolean(session));
  if (session) return null;

  const social = async (provider: "github" | "google") => {
    setError(null);
    const { error } = await authClient.signIn.social({ provider, callbackURL: "/app", errorCallbackURL: "/signin" });
    if (error) setError(error.message ?? "Couldn't start sign-in. Please try again.");
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    setBusy(true);
    setError(null);
    const { error } =
      mode === "signup"
        ? await authClient.signUp.email({ email, password, name: String(form.get("name")) })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (error) setError(error.message ?? "That didn't work. Check your details and try again.");
    else navigate("/app");
  };

  const auth = config?.auth;
  const none = auth && !auth.password && !auth.github && !auth.google;

  return (
    <section className="auth">
      <h2>{mode === "signup" ? "Create your account" : "Sign in to Showrium"}</h2>

      {auth?.github && (
        <button className="button secondary" onClick={() => social("github")}>
          Continue with GitHub
        </button>
      )}
      {auth?.google && (
        <button className="button secondary" onClick={() => social("google")}>
          Continue with Google
        </button>
      )}

      {auth?.password && (
        <>
          {(auth.github || auth.google) && <p className="divider">or with email</p>}
          <form className="form" onSubmit={submit}>
            {mode === "signup" && (
              <label>
                Name
                <input id="name" name="name" required autoComplete="name" />
              </label>
            )}
            <label>
              Email
              <input id="email" name="email" type="email" required autoComplete="email" />
            </label>
            <label>
              Password
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={10}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </label>
            <button className="button" disabled={busy}>
              {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>
          <p className="note">
            {mode === "signup" ? "Already have an account? " : "New to Showrium? "}
            <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === "signup" ? "signin" : "signup"); }}>
              {mode === "signup" ? "Sign in" : "Create an account"}
            </a>
          </p>
        </>
      )}

      {none && <p className="note">Sign-in opens soon. To join the beta, email support@showrium.com.</p>}
      {config?.signupMode === "waitlist" && (
        <div className="waitlist">
          <p className="note">New here? Showrium is invite-only for now. Join the waitlist and we'll email your invite.</p>
          <WaitlistForm />
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
