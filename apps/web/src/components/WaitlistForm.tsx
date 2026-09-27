import { useState, type FormEvent } from "react";
import { api } from "../lib";

// Posts to the same origin it's served from (showrium.com or app.showrium.com); the Worker allows both.
export function WaitlistForm() {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (state === "sending") return;
    const form = new FormData(e.currentTarget);
    setState("sending");
    setMessage(null);
    try {
      await api("/waitlist", {
        method: "POST",
        body: JSON.stringify({ email: String(form.get("email")), website: String(form.get("website") ?? "") }),
      });
      setState("done");
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "That didn't work. Please try again.");
    }
  };

  if (state === "done") {
    return (
      <p className="note" role="status">
        You're on the list. We'll email you when your invite is ready.
      </p>
    );
  }

  return (
    <form className="row" onSubmit={submit} aria-label="Join the waitlist">
      <label>
        Email
        <input id="waitlist-email" name="email" type="email" required maxLength={254} autoComplete="email" placeholder="you@example.com" />
      </label>
      {/* Honeypot for bots: hidden from people and screen readers. */}
      <input name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hp" />
      <button className="button" disabled={state === "sending"}>
        {state === "sending" ? "Joining…" : "Join the waitlist"}
      </button>
      {message && (
        <p className="error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
