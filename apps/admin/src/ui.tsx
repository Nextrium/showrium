// Small building blocks for the admin app. Text stays short; explanations live behind <Info>.
import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

/** Calls the admin API. Errors become exceptions with the server's message. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status}).`);
  return data as T;
}

/** Loads data, with a reload function. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const reload = useCallback(() => {
    if (!path) return;
    const n = ++latest.current;
    api<T>(path)
      .then((d) => n === latest.current && (setData(d), setError(null)))
      .catch((e: unknown) => n === latest.current && setError(e instanceof Error ? e.message : "Couldn't load."));
  }, [path]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

/**
 * A small "?" that shows a short explanation on hover, keyboard focus or tap, and hides when the
 * pointer leaves, focus moves away, or Escape is pressed.
 */
export function Info({ children, label = "More information" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  // Which way the pop-up opens, so it stays on screen near the edges.
  const [side, setSide] = useState<"center" | "left" | "right">("center");
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setSide(r.left < 140 ? "left" : window.innerWidth - r.right < 140 ? "right" : "center");
    setOpen(true);
  };
  return (
    <span ref={ref} className="relative inline-flex align-middle" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        className="inline-flex h-[18px] w-[18px] cursor-help items-center justify-center rounded-full border border-line-strong text-[11px] font-semibold text-muted hover:text-ink"
      >
        ?
      </button>
      {open && (
        <span role="tooltip" id={id} className={`absolute top-full z-20 mt-1.5 w-64 max-w-[calc(100vw-2rem)] rounded-lg ${side === "left" ? "left-0" : side === "right" ? "right-0" : "left-1/2 -translate-x-1/2"} border border-line bg-panel p-2.5 text-[12.5px] font-normal leading-snug text-ink-2 shadow-[var(--shadow)]`}>
          {children}
        </span>
      )}
    </span>
  );
}

const BTN = {
  primary: "bg-accent text-on-accent hover:brightness-105",
  secondary: "border border-line-strong bg-panel text-ink hover:bg-raised",
  ghost: "text-ink-2 hover:bg-raised",
  danger: "border border-line-strong bg-panel text-danger hover:bg-danger-soft",
};
export function Button({ variant = "secondary", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BTN }) {
  return <button type="button" {...rest} className={`inline-flex min-h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 text-[13.5px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${BTN[variant]} ${className}`} />;
}

export function Panel({ title, info, actions, children, className = "" }: { title?: string; info?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-panel p-4 ${className}`} aria-label={title}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {title && (
            <h2 className="m-0 flex items-center gap-1.5 text-[15px] font-semibold">
              {title} {info && <Info>{info}</Info>}
            </h2>
          )}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

const TONES = { neutral: "bg-raised text-ink-2", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", info: "bg-info-soft text-info", danger: "bg-danger-soft text-danger" };
export const Tag = ({ tone = "neutral", children }: { tone?: keyof typeof TONES; children: ReactNode }) => <span className={`inline-flex rounded-md px-2 py-0.5 text-[12px] font-semibold ${TONES[tone]}`}>{children}</span>;

export const Alert = ({ children }: { children: ReactNode }) => (
  <p role="alert" className="m-0 rounded-lg bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
    {children}
  </p>
);
export const Loading = () => (
  <p role="status" className="m-0 text-[13.5px] text-muted">
    Loading…
  </p>
);

export const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "–");
/** What a workspace is: paying, given a plan by staff, given full access by staff, or free. */
export const KIND_NAMES: Record<string, string> = { paying: "Paying", granted: "Granted plan", full_access: "Full access", free: "Free" };
export const KIND_TONES = { paying: "ok", granted: "warn", full_access: "info", free: "neutral" } as const;
export const PLAN_NAMES: Record<string, string> = { free: "Free", lite: "Lite", starter: "Starter", creator: "Creator", pro: "Pro", team: "Team (shared)", team_seats: "Team (per member)", staff: "Full access" };
