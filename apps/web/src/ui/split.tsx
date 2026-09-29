// List-and-detail layout (Posts, Ideas): a scrolling list of cards on the left and the selected
// item's details in a panel on the right. On phones and tablets the detail replaces the list,
// with a Back button. Selection lives in the address (?id=), so links and Back work.
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./kit";

type Tone = "accent" | "ok" | "warn" | "danger" | "info" | "neutral";
const NUMBER_TONES: Record<Tone, string> = {
  accent: "text-accent-ink",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  info: "text-info",
  neutral: "text-ink-2",
};

/** Reads and writes query parameters without leaving the page. */
export function useQueryParams(): [URLSearchParams, (changes: Record<string, string | null>, push?: boolean) => void] {
  const [params, setParams] = useState(() => new URLSearchParams(window.location.search));
  useEffect(() => {
    const onPop = () => setParams(new URLSearchParams(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const update = (changes: Record<string, string | null>, push = false) => {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const url = `${window.location.pathname}${next.size ? `?${next}` : ""}`;
    if (push) window.history.pushState({}, "", url);
    else window.history.replaceState({}, "", url);
    setParams(next);
  };
  return [params, update];
}

/** Big counts across the top, like a scoreboard. Each one is a filter. */
export function StatStrip({ items, active, onPick, label }: { items: { id: string; label: string; value: number; tone: Tone }[]; active: string; onPick: (id: string) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className={`grid grid-cols-3 overflow-hidden rounded-[18px] border border-line bg-panel ${items.length > 3 ? "sm:grid-cols-6" : ""}`}>
      {items.map((s, i) => {
        const on = s.id === active;
        return (
          <button
            key={s.id}
            role="tab"
            aria-selected={on}
            onClick={() => onPick(s.id)}
            className={`relative flex cursor-pointer flex-col items-center gap-1 border-line px-2 py-3.5 transition-colors ${i % 3 ? "border-l" : ""} ${i >= 3 ? "border-t sm:border-t-0" : ""} ${i === 3 ? "sm:border-l" : ""} ${on ? "bg-selected" : "hover:bg-raised"}`}
          >
            <span className={`font-display text-[26px] font-semibold leading-none tabular-nums ${s.value ? NUMBER_TONES[s.tone] : "text-muted"}`}>{s.value}</span>
            <span className={`font-mono text-[11px] uppercase tracking-[0.12em] ${on ? "text-ink" : "text-muted"}`}>{s.label}</span>
            {on && <span aria-hidden="true" className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-accent" />}
          </button>
        );
      })}
    </div>
  );
}

/** A small uppercase section label, as in the detail panel. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="m-0 font-mono text-[11.5px] font-medium uppercase tracking-[0.14em] text-muted">{children}</h3>;
}

/** A status tag in the list: mono, uppercase, tinted. */
export function Tag({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  const tones: Record<Tone, string> = {
    accent: "border-accent/40 text-accent-ink bg-accent-soft",
    ok: "border-ok/35 text-ok bg-ok-soft",
    warn: "border-warn/35 text-warn bg-warn-soft",
    danger: "border-danger/35 text-danger bg-danger-soft",
    info: "border-info/35 text-info bg-info-soft",
    neutral: "border-line-strong text-ink-2 bg-raised",
  };
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.1em] ${tones[tone]}`}>{children}</span>;
}

/** One card in the list. */
export function ListItem({ selected, onSelect, children, label }: { selected: boolean; onSelect: () => void; children: ReactNode; label: string }) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected || undefined}
        aria-label={label}
        onClick={onSelect}
        className={`relative flex w-full cursor-pointer flex-col gap-2 border-b border-line px-4 py-4 text-left transition-colors last:border-b-0 sm:px-5 ${selected ? "bg-selected" : "hover:bg-raised"}`}
      >
        {selected && <span aria-hidden="true" className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-accent" />}
        {children}
      </button>
    </li>
  );
}

/**
 * The two-column layout. `detail` is shown beside the list on wide screens; on narrower
 * screens it takes over the page while something is selected.
 */
export function Split({ list, detail, hasSelection, onBack, backLabel }: { list: ReactNode; detail: ReactNode; hasSelection: boolean; onBack: () => void; backLabel: string }) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className={`min-w-0 ${hasSelection ? "hidden lg:block" : ""}`}>{list}</div>
      <div className={`min-w-0 lg:sticky lg:top-4 ${hasSelection ? "" : "hidden lg:block"}`}>
        {hasSelection && (
          <button type="button" onClick={onBack} className="mb-3 inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-ink-2 hover:text-ink lg:hidden">
            <Icon name="arrowRight" size={15} className="rotate-180" />
            {backLabel}
          </button>
        )}
        {detail}
      </div>
    </div>
  );
}

/** The right-hand panel. Scrolls on its own on wide screens. */
export function DetailPanel({ children }: { children: ReactNode }) {
  return <aside className="flex min-w-0 flex-col gap-5 rounded-[18px] border border-line bg-panel p-5 sm:p-6 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">{children}</aside>;
}
