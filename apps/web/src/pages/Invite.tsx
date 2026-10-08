import { useEffect, useState, type FormEvent } from "react";
import { api, authClient, navigate, useApi } from "../lib";
import { Alert, Button } from "../ui/kit";

type Config = { auth: { password: boolean; github: boolean; google: boolean } };

export function CheckEmail({ email }: { email: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-line bg-panel p-5" role="status">
      <strong>Check your email</strong>
      <p className="note m-0">
        We sent a link to <strong>{email}</strong>. Open it to confirm your email and finish setting up. It works for 24 hours. If it isn't there in a few minutes, check your spam folder.
      </p>
    </div>
  );
}

/** New account with email and password, allowed by the invite cookie set when the link was checked. */
function EmailSignUp({ onError }: { onError: (message: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email")).trim();
    setBusy(true);
    onError(null);
    // The confirmation link signs the person in and opens the welcome steps.
    const { data, error } = await authClient.signUp.email({ name: String(form.get("name")).trim(), email, password: String(form.get("password")), callbackURL: "/app/welcome" });
    setBusy(false);
    if (error) onError(error.message ?? "Couldn't create the account. Check your details and try again.");
    else if (!data?.token) setCheckEmail(email); // email confirmation is required first
    else navigate("/app/welcome");
  };
  if (checkEmail) return <CheckEmail email={checkEmail} />;
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Your name
        <input name="name" required maxLength={80} autoComplete="name" />
      </label>
      <label>
        Email
        <input name="email" type="email" required autoComplete="email" />
      </label>
      <label>
        Password (at least 10 characters)
        <input name="password" type="password" required minLength={10} autoComplete="new-password" />
      </label>
      <Button disabled={busy}>{busy ? "Creating your account…" : "Create my account"}</Button>
    </form>
  );
}

export function Invite() {
  const { data: config } = useApi<Config>("/config");
  const { data: session, isPending } = authClient.useSession();
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
    setError(null);
    const { error } = await authClient.signIn.social({ provider, callbackURL: "/app", newUserCallbackURL: "/app/welcome", errorCallbackURL: "/signin" });
    if (error) setError(error.message ?? "Couldn't start sign-in. Please try again.");
  };

  const signOut = async () => {
    await authClient.signOut();
    // The invite stays valid on this device (its cookie is kept), so the options appear next.
  };

  const auth = config?.auth;
  const social_ = auth && (auth.github || auth.google);

  return (
    <section className="auth">
      <h1>{state === "invalid" ? "This invite link doesn't work" : "You're invited to Showrium"}</h1>
      {(state === "checking" || isPending) && state !== "invalid" && <p className="note">Checking your invite…</p>}

      {state === "valid" && !isPending && session && (
        <>
          <p className="note">
            You're signed in as <strong>{session.user.email}</strong>. This invite is for a new account, so sign out first to use it. Your current account isn't affected.
          </p>
          <Button onClick={signOut}>Sign out and use this invite</Button>
        </>
      )}

      {state === "valid" && !isPending && !session && (
        <>
          <p className="note">
            This creates your own Showrium account and workspace on the Free plan; you can upgrade any time. Create it in the way you prefer. The invite works with any email for
            the next 30 minutes on this device.
          </p>
          {auth?.google && (
            <Button variant="secondary" onClick={() => social("google")}>
              Continue with Google
            </Button>
          )}
          {auth?.github && (
            <Button variant="secondary" onClick={() => social("github")}>
              Continue with GitHub
            </Button>
          )}
          {auth?.password && (
            <>
              {social_ && <p className="divider">or with your email</p>}
              <EmailSignUp onError={setError} />
            </>
          )}
          {auth && !auth.password && !social_ && <p className="note">Sign-up isn't open in this environment yet.</p>}
        </>
      )}

      {state === "invalid" && (
        <p className="error" role="alert">
          {error ?? "This invite link is invalid, already used or expired."} The person who invited you can send a new one.
        </p>
      )}
      {state !== "invalid" && error && <Alert>{error}</Alert>}
    </section>
  );
}
