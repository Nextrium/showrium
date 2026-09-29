import { useState, type FormEvent } from "react";
import { api } from "../lib";
import { Alert } from "../ui/kit";

// Posts to the same origin it's served from (showrium.com or app.showrium.com); the Worker allows both.
export function WaitlistForm({ id = "waitlist" }: { id?: string }) {
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
      <Alert tone="ok">
        You're on the list. We'll email you once, when your invite is ready.
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} aria-label={id === "hero" ? "Join the waitlist" : `Join the waitlist (${id === "footer" ? "end of page" : id})`} className="flex w-full flex-col gap-2">
      <div className="flex w-full flex-col gap-2 sm:flex-row">
        <label htmlFor={`${id}-email`} className="sr-only">
          Email
        </label>
        <input id={`${id}-email`} name="email" type="email" required maxLength={254} autoComplete="email" placeholder="you@example.com" className="min-h-12 flex-1" />
        {/* Honeypot for bots: hidden from people and screen readers. */}
        <input name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hp" />
        <button className="button min-h-12 whitespace-nowrap px-5" disabled={state === "sending"}>
          {state === "sending" ? "Joining…" : "Join the waitlist"}
        </button>
      </div>
      {message && <Alert>{message}</Alert>}
    </form>
  );
}
