// What a post was written from, beyond the material: the person's own instructions, whether it's
// their view on someone else's work, and what web research found (links to check before approving).
import type { DraftSource } from "../pages/workspace/shared";

export function ResearchNotes({ source }: { source: DraftSource | null | undefined }) {
  if (!source) return null;
  const { research } = source;
  const showInstructions = source.instructions && source.kind !== "request";
  if (!showInstructions && source.stance !== "other" && !research) return null;
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line p-3.5 text-[13.5px]">
      {showInstructions && (
        <p className="m-0 text-ink-2">
          <strong className="font-semibold text-ink">Your instructions:</strong> {source.instructions}
        </p>
      )}
      {source.stance === "other" && <p className="m-0 text-ink-2">Written as your view on someone else's work.</p>}
      {research && (
        <>
          {research.summary && <p className="m-0 text-ink-2">{research.summary}</p>}
          {research.hints.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="font-medium text-ink">Your hints, checked</span>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {research.hints.map((h, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-1.5">
                    <span className={`rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold ${h.status === "confirmed" ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>
                      {h.status === "confirmed" ? "Found in a source" : "Not found: written as a claim"}
                    </span>
                    <span className="text-ink-2">{h.hint}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <span className="font-medium text-ink">Sources found on the web ({research.sources.length})</span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {research.sources.map((s) => (
                <li key={s.url} className="min-w-0">
                  <a className="text-accent-ink [overflow-wrap:anywhere]" href={s.url} target="_blank" rel="noopener noreferrer nofollow">
                    {s.title || new URL(s.url).hostname} ↗
                  </a>
                </li>
              ))}
            </ul>
            <span className="text-[12.5px] text-muted">Check these before approving. Only facts from these links (and your own hints) were used.</span>
          </div>
        </>
      )}
    </div>
  );
}
