import { useState } from "react";
import { api, timeAgo, useApi, useEditable } from "../../lib";
import { Alert, Badge, Chip, Icon, LinkButton, Loading, PageHeader, Panel, SaveBar, type IconName } from "../../ui/kit";
import { MODES, usePlatforms, type Persona, type Platform } from "./shared";

type Level = "coach" | "drafts" | "batch" | "autopilot";
type Settings = { level: Level; mode: string; platforms: Platform[]; postsPerWeek: number; publishHourUtc: number };
type Billing = { plan: string; fullAccess: boolean; features: { autopilot: Level } };

const ORDER: Level[] = ["coach", "drafts", "batch", "autopilot"];
const LEVELS: { id: Level; title: string; body: string; icon: IconName; needs: string }[] = [
  { id: "coach", title: "Ideas only", body: "Showrium finds things worth sharing. You decide what to write.", icon: "ideas", needs: "" },
  { id: "drafts", title: "Write drafts", body: "Posts are written from your best ideas each week. You approve each one.", icon: "edit", needs: "Starter" },
  { id: "batch", title: "Weekly batch", body: "The week's drafts wait in Posts, ready to approve in one tap.", icon: "posts", needs: "Starter" },
  { id: "autopilot", title: "Auto-schedule clean posts", body: "Posts with no warnings are scheduled to your connected accounts. You can cancel any of them. Never X, never replies.", icon: "automation", needs: "Creator" },
];

export function AutomationPage() {
  const settings = useApi<Settings & { lastRunAt: string | null }>("/autopilot");
  const { data: billing } = useApi<Billing>("/billing");
  const { data: personaData } = useApi<{ persona: Persona | null }>("/persona");
  const platforms = usePlatforms();
  const saved: Settings | null = settings.data ? { level: settings.data.level, mode: settings.data.mode, platforms: settings.data.platforms, postsPerWeek: settings.data.postsPerWeek, publishHourUtc: settings.data.publishHourUtc } : null;
  const { draft, setDraft, dirty, reset } = useEditable<Settings>("automation", saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  if (settings.error) return <Alert>{settings.error}</Alert>;
  if (!draft || !billing || !personaData) return <Loading />;
  const persona = personaData.persona;
  const maxIndex = ORDER.indexOf(billing.features.autopilot);
  const safe = persona?.monetizationSafe ?? false;
  const offset = -new Date().getTimezoneOffset() / 60;
  const toLocal = (utc: number) => (((utc + offset) % 24) + 24) % 24;
  const toUtc = (local: number) => (((local - offset) % 24) + 24) % 24;
  // Functional updates: each change builds on the latest draft, so quick successive edits all count.
  const set = <K extends keyof Settings>(k: K, v: Settings[K] | ((cur: Settings[K]) => Settings[K])) =>
    setDraft((d) => (d ? { ...d, [k]: typeof v === "function" ? (v as (cur: Settings[K]) => Settings[K])(d[k]) : v } : d));
  const toggle = (p: Platform) => set("platforms", (cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("/autopilot", { method: "PUT", body: JSON.stringify(draft) });
      setSavedAt(new Date().toISOString());
      settings.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Your changes are still here.");
    } finally {
      setSaving(false);
    }
  };

  if (!persona) {
    return (
      <>
        <PageHeader title="Automation" subtitle="Decide how much Showrium does for you." />
        <Panel>
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 text-sm text-ink-2">Set up your voice first, so automation knows how you sound and where you post.</span>
            <LinkButton to="/app/voice">Set up my voice</LinkButton>
          </div>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Automation"
        subtitle="Decide how much Showrium does for you. Replies are always yours to write."
        actions={!dirty && <span className="flex items-center gap-1.5 text-[13.5px] text-ok"><Icon name="check" size={15} strokeWidth={2.2} />{savedAt ? `Saved ${timeAgo(savedAt)}` : "All changes saved"}</span>}
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="How much Showrium does" id="levels">
          <div role="radiogroup" aria-labelledby="levels" className="flex flex-col gap-2.5">
            {LEVELS.map((l, i) => {
              const lockedByPlan = i > maxIndex;
              const lockedBySafe = l.id === "autopilot" && safe;
              const locked = lockedByPlan || lockedBySafe;
              const on = draft.level === l.id;
              return (
                <button
                  key={l.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-disabled={locked}
                  onClick={() => !locked && set("level", l.id)}
                  className={`flex w-full items-start gap-3.5 rounded-2xl border p-4 text-left transition-colors ${
                    locked ? "cursor-not-allowed border-dashed border-line-strong bg-transparent opacity-75" : on ? "cursor-pointer border-accent bg-accent-soft" : "cursor-pointer border-line bg-sunken hover:border-line-strong"
                  }`}
                >
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${on ? "bg-accent text-on-accent" : "bg-raised text-accent-ink"}`}><Icon name={locked ? "lock" : l.icon} /></span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                      {l.title}
                      {lockedByPlan && <Badge tone="neutral">Needs {l.needs} plan</Badge>}
                      {!lockedByPlan && lockedBySafe && <Badge tone="warn">Off in monetization-safe mode</Badge>}
                    </span>
                    <span className="text-[13.5px] text-muted">{l.body}</span>
                  </span>
                  <span aria-hidden="true" className={`mt-1 h-5 w-5 shrink-0 rounded-full border-2 ${on ? "border-accent bg-accent shadow-[inset_0_0_0_3px_var(--accent-soft)]" : "border-line-strong"}`} />
                </button>
              );
            })}
          </div>
          {maxIndex < ORDER.length - 1 && !billing.fullAccess && (
            <p className="m-0 text-sm text-muted">Your {billing.plan} plan includes the unlocked options. <a href="/app/billing">See plans →</a></p>
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Where and what" id="where">
            <span className="text-sm text-muted">Platforms</span>
            <div className="flex flex-wrap gap-2">
              {persona.platforms.map((p) => {
                const on = draft.platforms.includes(p);
                const label = platforms.find((x) => x.id === p)?.label ?? p;
                return <Chip key={p} on={on} onClick={() => toggle(p)}>{label}</Chip>;
              })}
            </div>
            <label>
              Style
              <select value={draft.mode} onChange={(e) => set("mode", e.target.value)}>
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-ink-2">Ideas turned into posts each week</span>
              <span className="flex items-center gap-2">
                <button type="button" aria-label="Fewer" disabled={draft.postsPerWeek <= 1} onClick={() => set("postsPerWeek", (n) => Math.max(1, n - 1))} className="h-9 w-9 cursor-pointer rounded-lg border border-line-strong bg-raised text-lg text-ink disabled:opacity-40">−</button>
                <span className="w-6 text-center font-mono">{draft.postsPerWeek}</span>
                <button type="button" aria-label="More" disabled={draft.postsPerWeek >= 14} onClick={() => set("postsPerWeek", (n) => Math.min(14, n + 1))} className="h-9 w-9 cursor-pointer rounded-lg border border-line-strong bg-raised text-lg text-ink disabled:opacity-40">+</button>
              </span>
            </div>
            <label>
              Schedule posts around (your time)
              <select value={toLocal(draft.publishHourUtc)} onChange={(e) => set("publishHourUtc", toUtc(Number(e.target.value)))}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
              </select>
            </label>
          </Panel>
          {settings.data?.lastRunAt && <p className="m-0 text-sm text-muted">Last automatic run {timeAgo(settings.data.lastRunAt)}.</p>}
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} error={error} savedNote="Everything here is saved. Change anything to edit." onSave={save} onDiscard={() => { reset(); setError(null); }} />
    </>
  );
}
