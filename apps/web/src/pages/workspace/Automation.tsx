import { useEffect, useRef, useState } from "react";
import { api, timeAgo, useApi, useEditable } from "../../lib";
import { Alert, Badge, Chip, Icon, Info, LinkButton, Loading, PageHeader, Panel, SaveBar, Switch } from "../../ui/kit";
import { MODES, usePlatforms, type Persona, type Platform } from "./shared";

type Rule = { write: boolean; schedule: boolean; approve: boolean };
type Mode = (typeof MODES)[number]["id"];
type Window = "morning" | "midday" | "afternoon" | "evening";
type Settings = {
  findIdeas: boolean;
  rules: Partial<Record<Platform, Rule>>;
  mix: Partial<Record<Mode, number>>;
  days: number[];
  publishHourUtc: number;
  timezone: string;
  windows: Window[];
  perDay: Partial<Record<Platform, number>>;
};
type Billing = { plan: string; fullAccess: boolean; features: { autopilot: "coach" | "batch" | "autopilot" } };
type Connection = { platform: string; status: string };
type Timing = { data: { platform: Platform; best: Window | null; posts: number }[] };

const OFF: Rule = { write: false, schedule: false, approve: false };
const API_PLATFORMS: Platform[] = ["x", "linkedin", "bluesky", "mastodon"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WINDOWS: { id: Window; label: string; hours: string }[] = [
  { id: "morning", label: "Morning", hours: "7–10" },
  { id: "midday", label: "Midday", hours: "11–14" },
  { id: "afternoon", label: "Afternoon", hours: "15–18" },
  { id: "evening", label: "Evening", hours: "19–22" },
];
/** The most automated posts a day per account (the same limits the server enforces). */
const DAILY_MAX: Record<Platform, number> = { x: 5, bluesky: 3, threads: 3, mastodon: 3, linkedin: 2, facebook: 2, instagram: 1, tiktok: 1, youtube_shorts: 1 };
const MAX_WEIGHT = 10;
const browserTz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();
const zones: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [browserTz, "UTC"];
  } catch {
    return [browserTz, "UTC"];
  }
})();

const SWITCHES: { key: keyof Rule; label: string; hint: string }[] = [
  { key: "write", label: "Write drafts", hint: "Posts are written from your best ideas, in your style balance." },
  { key: "schedule", label: "Schedule when approved", hint: "An approved post goes to the next good time on your connected account." },
  { key: "approve", label: "Approve for me", hint: "Clean posts from your own material are approved without you. You can still cancel them." },
];

function Stepper({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (n: number) => void }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      <button type="button" aria-label={`Fewer: ${label}`} disabled={value <= min} onClick={() => onChange(value - 1)} className="h-8 w-8 cursor-pointer rounded-lg border border-line-strong bg-raised text-ink disabled:opacity-40">−</button>
      <span className="w-5 text-center font-mono tabular-nums" aria-live="polite" aria-label={label}>{value}</span>
      <button type="button" aria-label={`More: ${label}`} disabled={value >= max} onClick={() => onChange(value + 1)} className="h-8 w-8 cursor-pointer rounded-lg border border-line-strong bg-raised text-ink disabled:opacity-40">+</button>
    </span>
  );
}

export function AutomationPage() {
  const settings = useApi<Settings & { lastRunAt: string | null }>("/autopilot");
  const { data: billing } = useApi<Billing>("/billing");
  const { data: personaData } = useApi<{ persona: Persona | null }>("/persona");
  const { data: conns } = useApi<{ data: Connection[] }>("/connections");
  const { data: timing } = useApi<Timing>("/autopilot/timing");
  const platformInfo = usePlatforms();
  const persona = personaData?.persona ?? null;

  // A stable shape (every platform of the person, in order) so "unsaved changes" compares like with like.
  const saved: Settings | null =
    settings.data && persona
      ? {
          findIdeas: settings.data.findIdeas,
          rules: Object.fromEntries(persona.platforms.map((p) => [p, { ...OFF, ...settings.data!.rules[p] }])),
          mix: Object.fromEntries(MODES.map((m) => [m.id, settings.data!.mix[m.id] ?? 0])),
          days: settings.data.days,
          publishHourUtc: settings.data.publishHourUtc,
          timezone: settings.data.timezone,
          windows: settings.data.windows,
          perDay: Object.fromEntries(persona.platforms.map((p) => [p, settings.data!.perDay[p] ?? 1])),
        }
      : null;
  const { draft, setDraft, dirty, reset } = useEditable<Settings>("automation", saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // A workspace still on the default "UTC" is offered the browser's timezone, as an unsaved change.
  const offeredTz = useRef(false);
  useEffect(() => {
    if (offeredTz.current || !draft) return;
    offeredTz.current = true;
    if (draft.timezone === "UTC" && browserTz !== "UTC") setDraft((d) => (d ? { ...d, timezone: browserTz } : d));
  }, [draft, setDraft]);

  if (settings.error) return <Alert>{settings.error}</Alert>;
  if (!personaData || !billing) return <Loading />;
  if (!persona) {
    return (
      <>
        <PageHeader title="Automation" />
        <Panel>
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 text-sm text-ink-2">Set up your voice first.</span>
            <LinkButton to="/app/voice">Set up my voice</LinkButton>
          </div>
        </Panel>
      </>
    );
  }
  if (!draft) return <Loading />;

  const level = billing.features.autopilot;
  const allowed = { write: level !== "coach", schedule: level !== "coach", approve: level === "autopilot" };
  const needs = { write: "Starter", schedule: "Starter", approve: "Creator" };
  const safe = persona.monetizationSafe;
  const connected = new Set((conns?.data ?? []).filter((c) => c.status === "active").map((c) => c.platform));
  const writing = persona.platforms.filter((p) => draft.rules[p]?.write);
  const active = persona.platforms.filter((p) => draft.rules[p]?.write || draft.rules[p]?.schedule);
  const label = (p: Platform) => platformInfo.find((x) => x.id === p)?.label ?? p;
  const learned = new Map((timing?.data ?? []).map((t) => [t.platform, t]));
  const total = Object.values(draft.mix).reduce<number>((a, b) => a + (b ?? 0), 0);

  const setRule = (p: Platform, key: keyof Rule, value: boolean) =>
    setDraft((d) => {
      if (!d) return d;
      const cur = { ...OFF, ...d.rules[p], [key]: value };
      if (key === "write" && !value) cur.approve = false; // approving needs writing
      return { ...d, rules: { ...d.rules, [p]: cur } };
    });
  const setMix = (m: Mode, n: number) => setDraft((d) => (d ? { ...d, mix: { ...d.mix, [m]: Math.max(0, Math.min(MAX_WEIGHT, n)) } } : d));
  const setPerDay = (p: Platform, n: number) => setDraft((d) => (d ? { ...d, perDay: { ...d.perDay, [p]: n } } : d));
  const toggleWindow = (w: Window) =>
    setDraft((d) => (d ? { ...d, windows: d.windows.includes(w) ? d.windows.filter((x) => x !== w) : WINDOWS.map((x) => x.id).filter((x) => x === w || d.windows.includes(x)) } : d));
  const toggleDay = (i: number) => setDraft((d) => (d ? { ...d, days: d.days.includes(i) ? d.days.filter((x) => x !== i) : [...d.days, i].sort() } : d));

  /** Why a switch can't be turned on, if it can't. */
  const lockReason = (p: Platform, key: keyof Rule): string | null => {
    if (!allowed[key]) return `Needs ${needs[key]} plan`;
    if (key === "approve" && p === "x") return "X needs your approval";
    if (key === "approve" && safe) return "Off in monetization-safe mode";
    if (key === "approve" && !draft.rules[p]?.write) return "Turn on writing first";
    if (key === "schedule" && !API_PLATFORMS.includes(p)) return "You post these yourself";
    return null;
  };
  const most = Math.max(0, ...active.map((p) => draft.perDay[p] ?? 1));
  const tooMany = most > draft.windows.length;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Only platforms with something switched on keep a number of posts a day.
      const perDay = Object.fromEntries(active.map((p) => [p, draft.perDay[p] ?? 1]));
      await api("/autopilot", { method: "PUT", body: JSON.stringify({ ...draft, perDay }) });
      setSavedAt(new Date().toISOString());
      settings.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Your changes are still here.");
    } finally {
      setSaving(false);
    }
  };

  const approving = writing.filter((p) => draft.rules[p]?.approve);
  const daily = writing.map((p) => `${draft.perDay[p] ?? 1} on ${label(p)}`).join(", ");
  const summary = !writing.length
    ? draft.findIdeas
      ? "Finding ideas in your sources. You decide what to write."
      : "Nothing runs automatically."
    : `Each posting day: ${daily}.${approving.length ? ` ${approving.map(label).join(", ")} approved for you.` : " You approve each one."}`;

  return (
    <>
      <PageHeader
        title="Automation"
        actions={!dirty && <span className="flex items-center gap-1.5 text-[13.5px] text-ok"><Icon name="check" size={15} strokeWidth={2.2} />{savedAt ? `Saved ${timeAgo(savedAt)}` : "All changes saved"}</span>}
      />
      <div className="flex items-start gap-3 rounded-[18px] border border-line bg-panel px-4 py-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink"><Icon name="automation" size={17} /></span>
        <p className="m-0 flex-1 text-[14.5px] text-ink-2" role="status">{summary}</p>
        <Info>Replies, likes, follows and messages are never automated. Posts that repeat a recent one are flagged and never approved for you.</Info>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Find ideas" id="find">
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-sm text-ink-2">
                Check my sources every few hours <Info>Included in every plan. When off, sources are checked only when you press “Check now” in Sources.</Info>
              </span>
              <Switch label="Find ideas" on={draft.findIdeas} onChange={(v) => setDraft((d) => (d ? { ...d, findIdeas: v } : d))} />
            </div>
          </Panel>

          <Panel title="Platforms" id="platforms">
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {persona.platforms.map((p) => {
                const on = active.includes(p);
                const t = learned.get(p);
                const max = Math.min(DAILY_MAX[p], 4);
                return (
                  <li key={p} className="flex flex-col gap-3 rounded-2xl border border-line bg-sunken p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{label(p)}</span>
                      {API_PLATFORMS.includes(p) ? (
                        connected.has(p) ? <Badge tone="ok">Connected</Badge> : <LinkButton to="/app/accounts" size="sm" variant="ghost">Connect to schedule</LinkButton>
                      ) : (
                        <Badge tone="neutral">Tap-to-post</Badge>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      {SWITCHES.map((s) => {
                        const reason = lockReason(p, s.key);
                        const isOn = Boolean(draft.rules[p]?.[s.key]);
                        return (
                          <div key={s.key} className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 ${isOn ? "border-accent/50 bg-accent-soft/50" : "border-line bg-panel"}`}>
                            <span className="flex min-w-0 flex-col">
                              <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-ink">
                                {s.label} <Info label={`About ${s.label}`}>{s.hint}</Info>
                              </span>
                              {reason && !isOn && <span className="text-[12px] text-muted">{reason}</span>}
                            </span>
                            <Switch label={`${s.label} on ${label(p)}`} on={isOn} disabled={Boolean(reason) && !isOn} onChange={(v) => setRule(p, s.key, v)} />
                          </div>
                        );
                      })}
                    </div>
                    {on && (
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 text-[13.5px] text-ink-2">
                          Posts a day <Info>{`${label(p)} allows up to ${DAILY_MAX[p]} automated post${DAILY_MAX[p] === 1 ? "" : "s"} a day. One post per time of day, at least 4 hours apart.`}</Info>
                        </span>
                        <Stepper value={draft.perDay[p] ?? 1} min={1} max={max} label={`posts a day on ${label(p)}`} onChange={(n) => setPerDay(p, n)} />
                      </div>
                    )}
                    {on && API_PLATFORMS.includes(p) && (
                      <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
                        {t?.best ? `Best time so far: ${WINDOWS.find((w) => w.id === t.best)?.label.toLowerCase()} (${t.posts} posts)` : "Learning the best times"}
                        <Info>Each post goes out at a different time inside your times of day. Showrium compares how posts do and slowly favours the time that works best, while still trying others.</Info>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {!allowed.approve && !billing.fullAccess && <a href="/app/billing" className="text-sm">More switches on other plans →</a>}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="When" id="when">
            <label className="flex flex-col gap-1 text-[13.5px]">
              Timezone
              <select value={draft.timezone} onChange={(e) => setDraft((d) => (d ? { ...d, timezone: e.target.value } : d))}>
                {(zones.includes(draft.timezone) ? zones : [draft.timezone, ...zones]).map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-[13px] text-muted">Days</span>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => (
                <Chip key={d} on={draft.days.includes(i)} onClick={() => toggleDay(i)}>
                  {d}
                </Chip>
              ))}
            </div>
            <span className="flex items-center gap-1.5 text-[13px] text-muted">
              Times of day <Info>At most one post per time of day on each account, at a different minute each time.</Info>
            </span>
            <div className="flex flex-wrap gap-1.5">
              {WINDOWS.map((w) => (
                <Chip key={w.id} on={draft.windows.includes(w.id)} onClick={() => toggleWindow(w.id)}>
                  {w.label} {w.hours}
                </Chip>
              ))}
            </div>
            {!draft.days.length && <p className="m-0 text-[13px] text-warn">Choose at least one day.</p>}
            {!draft.windows.length && <p className="m-0 text-[13px] text-warn">Choose at least one time of day.</p>}
            {tooMany && draft.windows.length > 0 && <p className="m-0 text-[13px] text-warn">{most} posts a day need {most} times of day.</p>}
          </Panel>

          <Panel
            title={<span className="flex items-center gap-1.5">Style balance <Info label="About style balance">How the styles are shared out. 2 Teach and 1 Smile means two teaching posts for each light one.</Info></span>}
            id="mix"
          >
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {MODES.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    {m.label} <Info label={`About ${m.label}`}>{m.hint}</Info>
                  </span>
                  <Stepper value={draft.mix[m.id] ?? 0} min={0} max={MAX_WEIGHT} label={m.label} onChange={(n) => setMix(m.id, n)} />
                </li>
              ))}
            </ul>
            {writing.length > 0 && !total && <p className="m-0 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn">Choose at least one style.</p>}
          </Panel>
          {settings.data?.lastRunAt && <p className="m-0 text-sm text-muted">Last run {timeAgo(settings.data.lastRunAt)}.</p>}
        </div>
      </div>
      <SaveBar dirty={dirty} saving={saving} error={error} savedNote="Everything here is saved." onSave={save} onDiscard={() => { reset(); setError(null); }} />
    </>
  );
}
