import { useState } from "react";
import { api, timeAgo, useApi, useEditable } from "../../lib";
import { Alert, Badge, Chip, Icon, LinkButton, Loading, PageHeader, Panel, SaveBar, Switch } from "../../ui/kit";
import { MODES, usePlatforms, type Persona, type Platform } from "./shared";

type Rule = { write: boolean; schedule: boolean; approve: boolean };
type Mode = (typeof MODES)[number]["id"];
type Settings = { findIdeas: boolean; rules: Partial<Record<Platform, Rule>>; mix: Partial<Record<Mode, number>>; days: number[]; publishHourUtc: number };
type Billing = { plan: string; fullAccess: boolean; features: { autopilot: "coach" | "batch" | "autopilot" } };
type Connection = { platform: string; status: string };

const OFF: Rule = { write: false, schedule: false, approve: false };
const API_PLATFORMS: Platform[] = ["x", "linkedin", "bluesky", "mastodon"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_WEEK = 14;

// Settings are stored in UTC; people choose in their own time. Moving the hour across midnight moves the day.
const offsetHours = -new Date().getTimezoneOffset() / 60;
const mod = (n: number, m: number) => ((n % m) + m) % m;
function toLocal(s: { publishHourUtc: number; days: number[] }) {
  const raw = s.publishHourUtc + offsetHours;
  const shift = Math.floor(raw / 24);
  return { hour: mod(Math.round(raw), 24), days: s.days.map((d) => mod(d + shift, 7)).sort() };
}
function toUtc(hour: number, days: number[]) {
  const raw = hour - offsetHours;
  const shift = Math.floor(raw / 24);
  return { publishHourUtc: mod(Math.round(raw), 24), days: days.map((d) => mod(d + shift, 7)).sort() };
}

const SWITCHES: { key: keyof Rule; label: string; hint: string }[] = [
  { key: "write", label: "Write drafts", hint: "Posts are written from your best ideas, following your weekly mix." },
  { key: "schedule", label: "Schedule when approved", hint: "When a post is approved, it goes to the next free slot on your connected account." },
  { key: "approve", label: "Approve for me", hint: "Clean posts from your own material are approved without you. You can still cancel them." },
];

export function AutomationPage() {
  const settings = useApi<Settings & { lastRunAt: string | null }>("/autopilot");
  const { data: billing } = useApi<Billing>("/billing");
  const { data: personaData } = useApi<{ persona: Persona | null }>("/persona");
  const { data: conns } = useApi<{ data: Connection[] }>("/connections");
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
        }
      : null;
  const { draft, setDraft, dirty, reset } = useEditable<Settings>("automation", saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  if (settings.error) return <Alert>{settings.error}</Alert>;
  if (!personaData || !billing) return <Loading />;
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
  if (!draft) return <Loading />;

  const level = billing.features.autopilot;
  const allowed = { write: level !== "coach", schedule: level !== "coach", approve: level === "autopilot" };
  const needs = { write: "Starter", schedule: "Starter", approve: "Creator" };
  const safe = persona.monetizationSafe;
  const connected = new Set((conns?.data ?? []).filter((c) => c.status === "active").map((c) => c.platform));
  const local = toLocal(draft);
  const total = Object.values(draft.mix).reduce<number>((a, b) => a + (b ?? 0), 0);
  const writing = persona.platforms.filter((p) => draft.rules[p]?.write);
  const label = (p: Platform) => platformInfo.find((x) => x.id === p)?.label ?? p;

  const setRule = (p: Platform, key: keyof Rule, value: boolean) =>
    setDraft((d) => {
      if (!d) return d;
      const cur = { ...OFF, ...d.rules[p], [key]: value };
      if (key === "write" && !value) cur.approve = false; // approving needs writing
      return { ...d, rules: { ...d.rules, [p]: cur } };
    });
  const setMix = (m: Mode, n: number) => setDraft((d) => (d ? { ...d, mix: { ...d.mix, [m]: Math.max(0, Math.min(7, n)) } } : d));
  const setWhen = (hour: number, days: number[]) => setDraft((d) => (d ? { ...d, ...toUtc(hour, days) } : d));

  /** Why a switch can't be turned on, if it can't. */
  const lockReason = (p: Platform, key: keyof Rule): string | null => {
    if (!allowed[key]) return `Needs ${needs[key]} plan`;
    if (key === "approve" && p === "x") return "X needs your approval";
    if (key === "approve" && safe) return "Off in monetization-safe mode";
    if (key === "approve" && !draft.rules[p]?.write) return "Turn on writing first";
    if (key === "schedule" && !API_PLATFORMS.includes(p)) return "You post these yourself";
    return null;
  };

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

  const approving = writing.filter((p) => draft.rules[p]?.approve);
  const summary = !writing.length
    ? draft.findIdeas
      ? "Showrium finds ideas in your sources. You decide what to write."
      : "Nothing runs automatically. Check sources and write posts whenever you like."
    : `Each week, ${total} post${total === 1 ? "" : "s"} written for ${writing.map(label).join(", ")}.${approving.length ? ` ${approving.map(label).join(", ")} ${approving.length === 1 ? "is" : "are"} approved for you.` : " You approve each one."}`;

  return (
    <>
      <PageHeader
        title="Automation"
        subtitle="Switch on only what you want, per platform. Replies are always yours to write."
        actions={!dirty && <span className="flex items-center gap-1.5 text-[13.5px] text-ok"><Icon name="check" size={15} strokeWidth={2.2} />{savedAt ? `Saved ${timeAgo(savedAt)}` : "All changes saved"}</span>}
      />
      <div className="flex items-start gap-3 rounded-[18px] border border-line bg-panel px-4 py-3.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink"><Icon name="automation" size={17} /></span>
        <p className="m-0 text-[14.5px] text-ink-2" role="status">{summary}</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Find ideas" id="find">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-ink-2">Check my sources for new ideas every few hours</span>
              <Switch label="Find ideas" on={draft.findIdeas} onChange={(v) => setDraft((d) => (d ? { ...d, findIdeas: v } : d))} />
            </div>
            <p className="m-0 text-[13px] text-muted">Included in every plan. When off, sources are checked only when you press “Check now” in Sources.</p>
          </Panel>

          <Panel title="On each platform" id="platforms">
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {persona.platforms.map((p) => (
                <li key={p} className="flex flex-col gap-3 rounded-2xl border border-line bg-sunken p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{label(p)}</span>
                    {API_PLATFORMS.includes(p) ? (
                      connected.has(p) ? <Badge tone="ok">Connected</Badge> : <LinkButton to="/app/accounts" size="sm" variant="ghost">Connect to schedule</LinkButton>
                    ) : (
                      <Badge tone="neutral">Tap-to-post</Badge>
                    )}
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-3">
                    {SWITCHES.map((s) => {
                      const reason = lockReason(p, s.key);
                      const on = Boolean(draft.rules[p]?.[s.key]);
                      return (
                        <div key={s.key} title={reason ?? s.hint} className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 ${on ? "border-accent/50 bg-accent-soft/50" : "border-line bg-panel"}`}>
                          <span className="flex min-w-0 flex-col">
                            <span className="text-[13.5px] font-medium text-ink">{s.label}</span>
                            {reason && !on && <span className="text-[12px] text-muted">{reason}</span>}
                          </span>
                          <Switch label={`${s.label} on ${label(p)}`} on={on} disabled={Boolean(reason) && !on} onChange={(v) => setRule(p, s.key, v)} />
                        </div>
                      );
                    })}
                  </div>
                </li>
              ))}
            </ul>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-muted">
              {SWITCHES.map((s) => <li key={s.key}><strong className="font-medium text-ink-2">{s.label}:</strong> {s.hint}</li>)}
            </ul>
            {!allowed.approve && !billing.fullAccess && <p className="m-0 text-sm text-muted">Your {billing.plan} plan includes the switches that are unlocked. <a href="/app/billing">See plans →</a></p>}
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Weekly style mix" id="mix">
            <p className="m-0 text-[13px] text-muted">How many posts of each kind to write each week. Each post goes to every platform with writing on.</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {MODES.map((m) => {
                const n = draft.mix[m.id] ?? 0;
                return (
                  <li key={m.id} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium text-ink">{m.label}</span>
                      <span className="truncate text-[12.5px] text-muted">{m.hint}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <button type="button" aria-label={`Fewer ${m.label}`} disabled={n <= 0} onClick={() => setMix(m.id, n - 1)} className="h-8 w-8 cursor-pointer rounded-lg border border-line-strong bg-raised text-ink disabled:opacity-40">−</button>
                      <span className="w-5 text-center font-mono tabular-nums" aria-live="polite">{n}</span>
                      <button type="button" aria-label={`More ${m.label}`} disabled={n >= 7 || total >= MAX_WEEK} onClick={() => setMix(m.id, n + 1)} className="h-8 w-8 cursor-pointer rounded-lg border border-line-strong bg-raised text-ink disabled:opacity-40">+</button>
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className={`flex items-center justify-between rounded-xl px-3 py-2 text-sm ${writing.length && !total ? "bg-warn-soft text-warn" : "bg-raised text-ink-2"}`}>
              <span>{writing.length && !total ? "Add at least one post a week" : "Posts a week"}</span>
              <span className="font-mono font-semibold">{total} / {MAX_WEEK}</span>
            </div>
          </Panel>

          <Panel title="When to post" id="when">
            <span className="text-[13px] text-muted">Days (for scheduled posts)</span>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => (
                <Chip key={d} on={local.days.includes(i)} onClick={() => setWhen(local.hour, local.days.includes(i) ? local.days.filter((x) => x !== i) : [...local.days, i])}>
                  {d}
                </Chip>
              ))}
            </div>
            {!local.days.length && <p className="m-0 text-[13px] text-warn">Choose at least one day.</p>}
            <label>
              Around (your time)
              <select value={local.hour} onChange={(e) => setWhen(Number(e.target.value), local.days)}>
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
