// Showrium UI kit: small, accessible building blocks styled with Tailwind and the design tokens.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "./Link";

const PATHS = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  posts: "M4 6h16M4 12h16M4 18h10",
  calendar: "M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  ideas: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z",
  video: "M4 6h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM16 10l5-3v10l-5-3",
  insights: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  sources: "M5 12a7 7 0 0 1 7 7M5 5a14 14 0 0 1 14 14M6 19h.01",
  accounts: "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM4 21a8 8 0 0 1 16 0",
  voice: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  automation: "M13 2 4 14h7l-1 8 9-12h-7z",
  team: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3",
  billing: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18",
  settings: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M14 4v4M8 10v4M16 16v4",
  audit: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  plus: "M12 5v14M5 12h14",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  check: "M5 12l5 5L20 7",
  chevrons: "M8 9l4-4 4 4M8 15l4 4 4-4",
  chevronDown: "M6 9l6 6 6-6",
  collapse: "M4 4h16v16H4zM9 4v16M15 10l-2 2 2 2",
  expand: "M4 4h16v16H4zM9 4v16M13 10l2 2-2 2",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6 6 18",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  photo: "M4 5h16v14H4zM4 15l4-4 5 5M14 13l2-2 4 4",
  git: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  comment: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  doc: "M6 3h9l5 5v13H6zM14 3v6h6",
  code: "M8 9l-3 3 3 3M16 9l3 3-3 3M13 5l-2 14",
  play: "M4 6h16v12H4zM10 9l5 3-5 3z",
  sun: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  monitor: "M3 5h18v11H3zM8 20h8M12 16v4",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
  refresh: "M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  alert: "M12 9v4M12 17h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className = "", strokeWidth = 1.8 }: { name: IconName; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path d={PATHS[name]} />
    </svg>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "inverse";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover border-transparent",
  secondary: "bg-raised text-ink border-line-strong hover:border-muted",
  ghost: "bg-transparent text-ink border-transparent hover:bg-raised",
  danger: "bg-transparent text-danger border-line-strong hover:border-danger",
  inverse: "bg-ink text-bg border-transparent hover:opacity-90",
};
const SIZES = { sm: "min-h-9 px-3 text-[13.5px] rounded-[10px]", md: "min-h-[42px] px-4 text-[14.5px] rounded-[11px]", lg: "min-h-12 px-5 text-[15px] rounded-xl" };

export function buttonClass(variant: Variant = "primary", size: keyof typeof SIZES = "md", extra = "") {
  return `inline-flex items-center justify-center gap-2 border font-semibold leading-none whitespace-nowrap no-underline cursor-pointer transition-colors disabled:opacity-55 disabled:cursor-not-allowed ${SIZES[size]} ${VARIANTS[variant]} ${extra}`;
}

export function Button({ variant = "primary", size = "md", icon, children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof SIZES; icon?: IconName }) {
  return (
    <button {...rest} className={buttonClass(variant, size, className)}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}

export function LinkButton({ to, variant = "primary", size = "md", icon, children, className = "" }: { to: string; variant?: Variant; size?: keyof typeof SIZES; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={buttonClass(variant, size, className)}>
      {icon && <Icon name={icon} size={16} />}
      {children}
    </Link>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="font-display text-[26px] font-semibold leading-tight sm:text-[30px]">{title}</h1>
        {subtitle && <p className="m-0 max-w-[70ch] text-[15px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

export function Panel({ title, action, children, className = "", id }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section aria-labelledby={title && id ? id : undefined} className={`flex min-w-0 flex-col gap-3 rounded-[18px] border border-line bg-panel p-5 ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-3">
          {title && <h2 id={id} className="font-sans text-base font-semibold tracking-normal">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Chip({ on, onClick, children, disabled, title }: { on: boolean; onClick?: () => void; children: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`min-h-9 rounded-full border px-3.5 text-[13.5px] transition-colors ${
        disabled
          ? "cursor-not-allowed border-dashed border-line-strong text-muted"
          : on
            ? "cursor-pointer border-accent bg-accent-soft font-semibold text-accent-ink"
            : "cursor-pointer border-line-strong bg-raised text-ink-2 hover:border-muted"
      }`}
    >
      {children}
    </button>
  );
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`flex h-[26px] w-11 shrink-0 cursor-pointer rounded-full p-[3px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? "justify-end bg-accent" : "justify-start bg-line-strong"}`}
    >
      <span className={`h-5 w-5 rounded-full ${on ? "bg-on-accent" : "bg-ink-2"}`} />
    </button>
  );
}

type Tone = "ok" | "warn" | "danger" | "info" | "neutral";
const TONES: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  neutral: "bg-raised text-ink-2",
};
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12.5px] font-medium ${TONES[tone]}`}>{children}</span>;
}

export function Dot({ tone }: { tone: Tone }) {
  const color = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", info: "bg-info", neutral: "bg-muted" }[tone];
  return <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

export function Meter({ value, max, label, detail }: { value: number; max: number; label: string; detail?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between gap-3 text-[13.5px]">
        <span className="text-ink-2">{label}</span>
        <span className="font-mono text-muted">{detail ?? `${value} / ${max}`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-raised" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        <div className={`h-full rounded-full ${pct > 85 ? "bg-danger" : "bg-accent"}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
    </div>
  );
}

export function Empty({ icon, title, body, action }: { icon: IconName; title: string; body: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-raised text-accent-ink"><Icon name={icon} size={22} /></span>
      <div className="flex flex-col gap-1">
        <span className="font-semibold">{title}</span>
        <span className="max-w-[46ch] text-sm text-muted">{body}</span>
      </div>
      {action}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="m-0 flex items-center gap-2 text-sm text-muted">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line-strong border-t-accent" aria-hidden="true" />
      {label}
    </p>
  );
}

export function Alert({ tone = "danger", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <p role={tone === "danger" ? "alert" : "status"} className={`m-0 rounded-xl px-3.5 py-2.5 text-sm ${TONES[tone]}`}>
      {children}
    </p>
  );
}

/**
 * The bar at the bottom of an editable page. Save is enabled only when something changed;
 * after saving it says so. It floats above the phone tab bar.
 */
export function SaveBar({ dirty, saving, error, savedNote, onSave, onDiscard, saveLabel = "Save changes" }: {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  savedNote: string;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
}) {
  return (
    <div className="sticky bottom-[84px] z-20 mt-2 flex flex-wrap items-center gap-3 rounded-2xl border border-line-strong bg-raised px-4 py-3 shadow-card md:bottom-4">
      <span role="status" className={`min-w-0 flex-1 text-sm ${error ? "text-danger" : dirty ? "text-warn" : "text-muted"}`}>
        {error ?? (saving ? "Saving…" : dirty ? "You have unsaved changes." : savedNote)}
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={!dirty || saving} onClick={onDiscard}>Discard</Button>
        <Button size="sm" disabled={!dirty || saving} onClick={onSave}>{saving ? "Saving…" : saveLabel}</Button>
      </div>
    </div>
  );
}
