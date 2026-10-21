// Small pieces shared by the phase 2 pages: stat tiles, plain tables, money and "how long ago".
import { useState, type ReactNode } from "react";
import { Info } from "../ui";

export function Stat({ label, value, sub, info, tone }: { label: string; value: string | number; sub?: string | undefined; info?: string | undefined; tone?: "warn" | "danger" | "ok" | undefined }) {
  const color = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "";
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-panel p-4">
      <span className="flex items-center gap-1.5 text-[13px] text-muted">
        {label} {info && <Info>{info}</Info>}
      </span>
      <span className={`font-display text-[26px] font-semibold leading-none ${color}`}>{value}</span>
      {sub && <span className="text-[12.5px] text-muted">{sub}</span>}
    </div>
  );
}

/** A plain table that scrolls sideways on phones. Columns: label, cell renderer, and right-aligned numbers. */
export function Table<T>({ rows, cols, empty = "Nothing here." }: { rows: T[]; cols: { label: string; cell: (r: T) => ReactNode; num?: boolean }[]; empty?: string }) {
  if (!rows.length) return <p className="m-0 text-[13.5px] text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="text-left text-muted">
            {cols.map((c) => (
              <th key={c.label} className={`whitespace-nowrap py-1.5 pr-3 font-medium ${c.num ? "text-right" : ""}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line align-top">
              {cols.map((c) => (
                <td key={c.label} className={`py-1.5 pr-3 ${c.num ? "whitespace-nowrap text-right tabular-nums" : "[overflow-wrap:anywhere]"}`}>{c.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Daily amounts as thin bars, with the value on hover. */
export function DayBars({ title, days, format }: { title: string; days: { date: string; value: number }[]; format: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0.000001, ...days.map((d) => d.value));
  const total = days.reduce((a, d) => a + d.value, 0);
  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium text-ink-2">{title}</span>
        <span className="text-muted">{format(total)} in {days.length} days</span>
      </figcaption>
      <div className="relative flex h-24 items-end gap-[2px] border-b border-line" role="img" aria-label={`${title}: ${format(total)} in ${days.length} days`}>
        {days.map((d, i) => (
          <div key={d.date} className="flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <div className={`w-full rounded-t-[4px] ${hover === i ? "bg-accent-ink" : "bg-accent"}`} style={{ height: `${d.value ? Math.max(4, (d.value / max) * 100) : 0}%` }} />
          </div>
        ))}
        {hover !== null && (
          <div className="pointer-events-none absolute -top-8 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink shadow-[var(--shadow)]" style={{ left: `min(calc(${(hover / days.length) * 100}%), calc(100% - 7rem))` }}>
            {new Date(days[hover]!.date).toLocaleDateString(undefined, { day: "numeric", month: "short" })}: <strong>{format(days[hover]!.value)}</strong>
          </div>
        )}
      </div>
    </figure>
  );
}

export const money = (usd: number) => (usd < 0.01 && usd > 0 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}
