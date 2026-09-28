import { useState } from "react";
import { api, timeAgo, useApi, useEditable } from "../../lib";
import { Link } from "../../ui/Link";
import { Alert, Button, Chip, Icon, LinkButton, Loading, PageHeader, Panel, SaveBar, Switch } from "../../ui/kit";
import { usePlatforms, type Persona, type Platform } from "./shared";

// Suggestions people pick from; "Other" adds their own. Lists and free text are both stored
// in the same fields the writer already uses, so nothing else changes.
const GROUPS = {
  role: { label: "You are", hint: "Pick what fits", max: 4, options: ["Founder", "Software engineer", "Designer", "Product manager", "Data scientist", "Teacher", "Student", "Marketer", "Creator", "Researcher", "Small business owner", "Consultant", "Healthcare worker", "Writer"] },
  expertise: { label: "You know about", hint: "The subjects you can speak to", max: 15, options: ["Web development", "Mobile apps", "AI", "Cloud", "Security", "Data", "Design", "Product", "Startups", "Marketing", "Education", "Health", "Finance", "Open source"] },
  interests: { label: "You're into", hint: "Topics you enjoy talking about", max: 15, options: ["Tech news", "Careers", "Productivity", "African tech", "Remote work", "Leadership", "Writing", "Photography", "Music", "Sport", "Travel", "Food"] },
  audience: { label: "You talk to", hint: "Who you want to reach", max: 8, options: ["Developers", "Founders", "Recruiters", "Students", "Customers", "Designers", "Investors", "Everyone"] },
  voice: { label: "You sound", hint: "How your posts should feel", max: 8, options: ["Warm", "Plain", "Funny", "Direct", "Curious", "Calm", "Bold", "Thoughtful", "Encouraging", "No hype"] },
  avoid: { label: "Never write about", hint: "Topics and habits to keep out", max: 15, options: ["Politics", "Religion", "Hype words", "Lots of emoji", "Client names", "Salary numbers"] },
  blockers: { label: "What stopped you posting", hint: "So Showrium can help with it", max: 10, options: ["I don't know what's worth sharing", "I don't want to sound like I'm bragging", "I don't have time", "Every platform wants something different", "I have no photos or video", "I worry about what people will think"] },
} as const;
type GroupKey = keyof typeof GROUPS;

type Form = Record<GroupKey, string[]> & { displayName: string; platforms: Platform[]; monetizationSafe: boolean };

const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
function toForm(p: Persona | null, fallbackName: string): Form {
  return {
    displayName: p?.displayName ?? fallbackName,
    role: split(p?.role ?? ""),
    expertise: p?.expertise ?? [],
    interests: p?.interests ?? [],
    audience: split(p?.audience ?? ""),
    voice: split(p?.voice ?? ""),
    avoid: p?.avoid ?? [],
    blockers: p?.blockers ?? [],
    platforms: p?.platforms ?? [],
    monetizationSafe: p?.monetizationSafe ?? false,
  };
}
function toPersona(f: Form) {
  return {
    displayName: f.displayName.trim(),
    role: f.role.join(", ").slice(0, 120),
    expertise: f.expertise,
    interests: f.interests,
    audience: f.audience.join(", ").slice(0, 300),
    voice: f.voice.join(", ").slice(0, 500),
    avoid: f.avoid,
    blockers: f.blockers,
    platforms: f.platforms,
    monetizationSafe: f.monetizationSafe,
  };
}

function ChipGroup({ k, values, onChange }: { k: GroupKey; values: string[]; onChange: (fn: (cur: string[]) => string[]) => void }) {
  const g = GROUPS[k];
  const [other, setOther] = useState("");
  const options = [...g.options, ...values.filter((v) => !(g.options as readonly string[]).includes(v))];
  const full = values.length >= g.max;
  const add = () => {
    const v = other.trim().slice(0, 80);
    if (!v || full) return;
    onChange((cur) => (cur.some((x) => x.toLowerCase() === v.toLowerCase()) || cur.length >= g.max ? cur : [...cur, v]));
    setOther("");
  };
  return (
    <fieldset className="m-0 grid gap-3 border-0 border-t border-line p-0 pt-4 first:border-t-0 first:pt-0 md:grid-cols-[200px_minmax(0,1fr)] md:gap-6">
      <legend className="sr-only">{g.label}</legend>
      <div className="flex flex-col gap-0.5">
        <span className="text-[14.5px] font-semibold">{g.label}</span>
        <span className="text-[13px] text-muted">{g.hint}{full ? ` · up to ${g.max}` : ""}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {options.map((o) => {
          const on = values.includes(o);
          return (
            <Chip key={o} on={on} disabled={!on && full} onClick={() => onChange((cur) => (cur.includes(o) ? cur.filter((x) => x !== o) : cur.length >= g.max ? cur : [...cur, o]))}>
              {o}
            </Chip>
          );
        })}
        <span className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor={`other-${k}`}>Add your own to “{g.label}”</label>
          <input
            id={`other-${k}`}
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Other…"
            maxLength={80}
            disabled={full}
            className="!min-h-9 !w-40 !rounded-full !border-dashed !bg-transparent !px-3.5 !py-1 !text-[13.5px]"
          />
          <Button type="button" variant="secondary" size="sm" disabled={!other.trim() || full} onClick={add}>Add</Button>
        </span>
      </div>
    </fieldset>
  );
}

function Summary({ form, platformLabels }: { form: Form; platformLabels: Record<string, string> }) {
  const rows: [string, string[]][] = [
    ["Writes as", [form.displayName]],
    ...(Object.keys(GROUPS) as GroupKey[]).map((k) => [GROUPS[k].label, form[k]] as [string, string[]]),
    ["Posts on", form.platforms.map((p) => platformLabels[p] ?? p)],
    ["Monetization-safe", [form.monetizationSafe ? "On: every post needs your approval" : "Off"]],
  ];
  return (
    <div className="flex flex-col">
      {rows.map(([label, values]) => (
        <div key={label} className="grid gap-2 border-t border-line py-3.5 first:border-t-0 first:pt-0 md:grid-cols-[200px_minmax(0,1fr)] md:gap-6">
          <span className="text-sm text-muted">{label}</span>
          <div className="flex flex-wrap gap-2">
            {values.length ? values.map((v) => <span key={v} className="rounded-full bg-raised px-3 py-1 text-[13.5px]">{v}</span>) : <span className="text-sm text-muted">Not set</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function VoicePage() {
  const { data, error: loadError, reload } = useApi<{ persona: Persona | null; updatedAt?: string }>("/persona");
  const platforms = usePlatforms();
  const labels = Object.fromEntries(platforms.map((p) => [p.id, p.label]));
  const persona = data?.persona ?? null;
  const saved = data ? toForm(persona, "") : null;
  const { draft, setDraft, dirty, reset } = useEditable<Form>("voice", saved);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState(false);

  if (loadError) return <Alert>{loadError}</Alert>;
  if (!data || !draft) return <Loading />;
  const isNew = !persona;
  const showForm = isNew || editing;

  // Functional updates: each change builds on the latest draft, so quick successive edits all count.
  const set = <K extends keyof Form>(k: K, v: Form[K] | ((cur: Form[K]) => Form[K])) =>
    setDraft((d) => (d ? { ...d, [k]: typeof v === "function" ? (v as (cur: Form[K]) => Form[K])(d[k]) : v } : d));
  const save = async () => {
    if (!draft.displayName.trim()) {
      setError("Add the name to write as.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api("/persona", { method: "PUT", body: JSON.stringify(toPersona(draft)) });
      setSavedAt(new Date().toISOString());
      setJustCreated(isNew);
      setEditing(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Your changes are still here.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Brand voice"
        subtitle="Who you are and how you sound. Every post is written from this."
        actions={
          !showForm && (
            <>
              <span className="flex items-center gap-1.5 text-[13.5px] text-ok"><Icon name="check" size={15} strokeWidth={2.2} />{savedAt ? `Saved ${timeAgo(savedAt)}` : "Saved"}</span>
              <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>Edit</Button>
            </>
          )
        }
      />

      {justCreated && !showForm && (
        <Panel className="bg-accent-soft">
          <div className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 text-sm text-ink-2"><strong className="text-ink">Your voice is set.</strong> Next, give Showrium something to write about.</span>
            <LinkButton to="/app/sources" variant="secondary" size="sm">Add a source</LinkButton>
            <LinkButton to="/app/new" size="sm">Write my first post</LinkButton>
          </div>
        </Panel>
      )}

      {!showForm ? (
        <Panel><Summary form={toForm(persona, "")} platformLabels={labels} /></Panel>
      ) : (
        <>
          <Panel>
            <div className="flex flex-col gap-4">
              <div className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)] md:gap-6">
                <label htmlFor="displayName" className="text-[14.5px] font-semibold text-ink">Name to write as</label>
                <input id="displayName" value={draft.displayName} maxLength={80} onChange={(e) => set("displayName", e.target.value)} className="md:max-w-sm" />
              </div>
              {(Object.keys(GROUPS) as GroupKey[]).map((k) => (
                <ChipGroup key={k} k={k} values={draft[k]} onChange={(fn) => set(k, fn)} />
              ))}
              <fieldset className="m-0 grid gap-3 border-0 border-t border-line p-0 pt-4 md:grid-cols-[200px_minmax(0,1fr)] md:gap-6">
                <legend className="sr-only">Platforms you use</legend>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[14.5px] font-semibold">You post on</span>
                  <span className="text-[13px] text-muted">Only these are used. Nothing is chosen for you.</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {platforms.map((p) => {
                    const on = draft.platforms.includes(p.id);
                    return <Chip key={p.id} on={on} onClick={() => set("platforms", (cur) => (cur.includes(p.id) ? cur.filter((x) => x !== p.id) : [...cur, p.id]))}>{p.label}</Chip>;
                  })}
                </div>
              </fieldset>
              <div className="grid items-center gap-3 border-t border-line pt-4 md:grid-cols-[200px_minmax(0,1fr)] md:gap-6">
                <span className="text-[14.5px] font-semibold">Monetization-safe</span>
                <div className="flex items-start gap-3">
                  <Switch on={draft.monetizationSafe} onChange={(v) => set("monetizationSafe", v)} label="Monetization-safe mode" />
                  <span className="text-[13.5px] text-muted">Every post needs your approval, no full autopilot, and X posts go through your own X app.</span>
                </div>
              </div>
            </div>
          </Panel>
          {isNew ? (
            <div className="sticky bottom-[84px] z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-line-strong bg-raised px-4 py-3 shadow-card md:bottom-4">
              <span role="status" className={`min-w-0 flex-1 text-sm ${error ? "text-danger" : "text-muted"}`}>{error ?? "Pick what fits. You can change it any time."}</span>
              <Button disabled={saving} onClick={save}>{saving ? "Saving…" : "Save my voice"}</Button>
            </div>
          ) : (
            <SaveBar
              dirty={dirty}
              saving={saving}
              error={error}
              savedNote="No changes yet. Pick or remove anything above."
              onSave={save}
              onDiscard={() => {
                reset();
                setError(null);
                setEditing(false);
              }}
            />
          )}
          {!isNew && !dirty && (
            <p className="m-0 text-sm text-muted">
              <button type="button" onClick={() => setEditing(false)} className="cursor-pointer border-0 bg-transparent p-0 text-accent-ink underline">Back to summary</button>
            </p>
          )}
        </>
      )}
      {!showForm && <p className="m-0 text-sm text-muted">Tip: the more specific “You know about” is, the more your posts sound like you. <Link to="/app/new">Try it on a post →</Link></p>}
    </>
  );
}
