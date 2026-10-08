import { useState, type FormEvent } from "react";
import { WaitlistForm } from "../components/WaitlistForm";
import { ForgotPassword } from "./ResetPassword";
import { CheckEmail } from "./Invite";
import { authClient, navigate, useApi, useRedirect } from "../lib";

type Config = { auth: { password: boolean; passwordReset: boolean; github: boolean; google: boolean }; signupMode: "waitlist" | "allowlist" };

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
  const [forgot, setForgot] = useState(() => new URLSearchParams(window.location.search).has("forgot"));
  const [checkEmail, setCheckEmail] = useState<string | null>(null);
  const [twoStep, setTwoStep] = useState(false);
  const [justReset] = useState(() => new URLSearchParams(window.location.search).has("reset"));

  useRedirect("/app", Boolean(session));
  if (session) return null;
  if (forgot) return <ForgotPassword onBack={() => setForgot(false)} />;
  if (checkEmail) return <section className="auth"><h1>Confirm your email</h1><CheckEmail email={checkEmail} /></section>;
  if (twoStep) return <TwoStepCode onBack={() => setTwoStep(false)} />;

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
    if (mode === "signup") {
      const { data, error } = await authClient.signUp.email({ email, password, name: String(form.get("name")), callbackURL: "/app/welcome" });
      setBusy(false);
      if (error) setError(error.message ?? "That didn't work. Check your details and try again.");
      else if (!data?.token) setCheckEmail(email);
      else navigate("/app");
      return;
    }
    const { data, error } = await authClient.signIn.email({ email, password, callbackURL: "/app" });
    setBusy(false);
    if (error?.code === "EMAIL_NOT_VERIFIED") setCheckEmail(email); // a fresh link was just sent
    else if (error) setError(error.message ?? "That didn't work. Check your details and try again.");
    else if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) setTwoStep(true);
    else navigate("/app");
  };

  const auth = config?.auth;
  const none = auth && !auth.password && !auth.github && !auth.google;

  return (
    <section className="auth">
      <h1>{mode === "signup" ? "Create your account" : "Sign in to Showrium"}</h1>
      {justReset && <p className="note" role="status">Your password was changed. Sign in with the new one.</p>}

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
          {mode === "signin" && auth.passwordReset && (
            <p className="note">
              <a href="/signin?forgot=1" onClick={(e) => { e.preventDefault(); setForgot(true); }}>Forgot your password?</a>
            </p>
          )}
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

/** The second step of signing in: a code from the authenticator app, or a backup code. */
function TwoStepCode({ onBack }: { onBack: () => void }) {
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const code = String(f.get("code")).replace(/\s/g, "");
    const trustDevice = f.get("trust") === "on";
    setBusy(true);
    setError(null);
    const { error } = backup ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice }) : await authClient.twoFactor.verifyTotp({ code, trustDevice });
    setBusy(false);
    if (error) setError(backup ? "That backup code didn't work, or it was already used." : "That code didn't work. Use the newest code from your app, or a backup code.");
    else navigate("/app");
  };
  return (
    <section className="auth">
      <h1>Two-step sign-in</h1>
      <form className="form" onSubmit={submit}>
        <label>
          {backup ? "One of your backup codes" : "The 6-digit code from your authenticator app"}
          <input name="code" required autoFocus inputMode={backup ? "text" : "numeric"} autoComplete="one-time-code" maxLength={20} />
        </label>
        <label className="check">
          <input type="checkbox" name="trust" />
          Trust this device for 30 days
        </label>
        <button className="button" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="note">
        <a href="#" onClick={(e) => { e.preventDefault(); setBackup(!backup); }}>{backup ? "Use the authenticator app instead" : "Use a backup code instead"}</a>
        {" · "}
        <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>Back</a>
      </p>
    </section>
  );
}
