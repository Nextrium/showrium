import { useState, type FormEvent } from "react";
import { authClient, navigate } from "../lib";
import { Alert, Button } from "../ui/kit";

/** Asks for a reset link. The answer is the same whether or not the email has an account. */
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email")).trim();
    setBusy(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
    setBusy(false);
    if (error) setError(error.message ?? "Couldn't send the link. Try again in a minute.");
    else setSent(true);
  };

  return (
    <section className="auth">
      <h1>Reset your password</h1>
      {sent ? (
        <Alert tone="ok">If that email has a Showrium account, a reset link is on its way. It works for one hour. Check your spam folder if it doesn't arrive.</Alert>
      ) : (
        <form className="form" onSubmit={submit}>
          <p className="note">Enter the email you signed up with, and we'll send you a link to choose a new password.</p>
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <Button disabled={busy}>{busy ? "Sending…" : "Send reset link"}</Button>
        </form>
      )}
      {error && <Alert>{error}</Alert>}
      <p className="note">
        <a href="/signin" onClick={(e) => { e.preventDefault(); onBack(); }}>Back to sign in</a>
      </p>
    </section>
  );
}

/** Opened from the email: /reset-password?token=… (or ?error=INVALID_TOKEN). */
export function ResetPassword() {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const token = params.get("token");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const newPassword = String(f.get("password"));
    if (newPassword !== String(f.get("confirm"))) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword, token: token! });
    setBusy(false);
    if (error) setError(/token/i.test(error.message ?? "") || !error.message ? "This link has expired or was already used. Ask for a new one from the sign-in page." : error.message);
    else navigate("/signin?reset=1");
  };

  if (!token || params.get("error")) {
    return (
      <section className="auth">
        <h1>This link doesn't work</h1>
        <p className="note">Reset links work once, for one hour. Ask for a new one from the sign-in page.</p>
        <Button onClick={() => navigate("/signin?forgot=1")}>Get a new link</Button>
      </section>
    );
  }
  return (
    <section className="auth">
      <h1>Choose a new password</h1>
      <form className="form" onSubmit={submit}>
        <label>
          New password (at least 10 characters)
          <input name="password" type="password" required minLength={10} autoComplete="new-password" />
        </label>
        <label>
          The same password again
          <input name="confirm" type="password" required minLength={10} autoComplete="new-password" />
        </label>
        <Button disabled={busy}>{busy ? "Saving…" : "Save new password"}</Button>
      </form>
      {error && <Alert>{error}</Alert>}
      <p className="note">You'll be signed out on your other devices.</p>
    </section>
  );
}
