import { useEffect, useState } from "react";
import { api, authClient, navigate, useApi } from "../../lib";
import { Alert, Button, Chip, Icon, LinkButton, Panel, type IconName } from "../../ui/kit";
import { usePlatforms, type Persona, type Platform } from "./shared";

// What people do → how Showrium describes them, and where their work usually lives.
const WORK: { id: string; label: string; role: string; icon: IconName; sources: string[] }[] = [
  { id: "dev", label: "I build software", role: "Software engineer", icon: "code", sources: ["github", "devto", "mcp"] },
  { id: "founder", label: "I run a startup", role: "Founder", icon: "automation", sources: ["rss", "github", "prompt"] },
  { id: "design", label: "I design", role: "Designer", icon: "edit", sources: ["photos", "rss", "prompt"] },
  { id: "create", label: "I create or write", role: "Creator", icon: "play", sources: ["rss", "youtube", "podcast"] },
  { id: "teach", label: "I teach or study", role: "Teacher", icon: "ideas", sources: ["prompt", "photos", "youtube"] },
  { id: "market", label: "I do marketing", role: "Marketer", icon: "insights", sources: ["rss", "youtube", "prompt"] },
  { id: "business", label: "I run a business", role: "Small business owner", icon: "billing", sources: ["rss", "photos", "prompt"] },
  { id: "care", label: "I work in health or care", role: "Healthcare worker", icon: "team", sources: ["prompt", "photos"] },
];
const SOURCES: Record<string, { name: string; body: string; icon: IconName; to: string }> = {
  github: { name: "A GitHub repository", body: "Releases and each day’s commits become ideas.", icon: "git", to: "/app/sources?add=github" },
  devto: { name: "Your developer blog", body: "Dev.to, Hashnode or Medium.", icon: "sources", to: "/app/sources?add=devto" },
  mcp: { name: "Your AI coding tool", body: "Claude Code or Cursor tell Showrium what you shipped.", icon: "code", to: "/app/settings" },
  rss: { name: "Your blog or website", body: "Showrium finds its feed or watches the page.", icon: "globe", to: "/app/sources?add=rss" },
  youtube: { name: "Your YouTube channel", body: "New videos become posts that point to them.", icon: "play", to: "/app/sources?add=youtube" },
  podcast: { name: "Your podcast", body: "New episodes become posts.", icon: "voice", to: "/app/sources?add=podcast" },
  photos: { name: "Photos and documents", body: "Your work, a whiteboard, slides or a PDF.", icon: "photo", to: "/app/sources?add=photos" },
  prompt: { name: "A daily question", body: "On Home, matched to what you do. Answer in a sentence.", icon: "comment", to: "/app" },
};

export function WelcomePage() {
  const { data: session } = authClient.useSession();
  const { data } = useApi<{ persona: Persona | null }>("/persona");
  const platforms = usePlatforms();
  const [step, setStep] = useState(1);
  const [work, setWork] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Platform[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session?.user.name && !name) setName(session.user.name);
  }, [session?.user.name, name]);
  // Already set up (for example, came back to this page): continue at the sources step.
  useEffect(() => {
    if (data?.persona && step === 1) setStep(3);
  }, [data?.persona, step]);

  const toggleWork = (id: string) => setWork((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 3 ? cur : [...cur, id]));
  const togglePlatform = (p: Platform) => setChosen((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  const roles = [...WORK.filter((w) => work.includes(w.id)).map((w) => w.role), ...(other.trim() ? [other.trim().slice(0, 60)] : [])];

  const saveVoice = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/persona", { method: "PUT", body: JSON.stringify({ displayName: name.trim() || "Me", role: roles.join(", ").slice(0, 120), platforms: chosen }) });
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const suggested = [...new Set(WORK.filter((w) => work.includes(w.id)).flatMap((w) => w.sources))];
  const shown = (suggested.length ? suggested : ["rss", "prompt", "photos", "github"]).slice(0, 5);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <span className="font-mono text-[12.5px] uppercase tracking-[0.08em] text-accent-ink">Step {step} of 3</span>
        <div className="flex gap-1.5" aria-hidden="true">
          {[1, 2, 3].map((s) => <span key={s} className={`h-1.5 flex-1 rounded-full ${s <= step ? "bg-accent" : "bg-raised"}`} />)}
        </div>
      </div>

      {step === 1 && (
        <>
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-[28px] font-semibold">Welcome to Showrium</h1>
            <p className="m-0 text-muted">What do you do? Pick up to three. It shapes your ideas and how posts sound.</p>
          </div>
          <div role="group" aria-label="What you do" className="grid gap-2.5 sm:grid-cols-2">
            {WORK.map((w) => {
              const on = work.includes(w.id);
              return (
                <button
                  key={w.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleWork(w.id)}
                  className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-2xl border p-3.5 text-left text-[15px] transition-colors ${on ? "border-accent bg-accent-soft font-semibold text-ink" : "border-line bg-panel text-ink-2 hover:border-line-strong"}`}
                >
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${on ? "bg-accent text-on-accent" : "bg-raised text-accent-ink"}`}><Icon name={w.icon} size={17} /></span>
                  {w.label}
                </button>
              );
            })}
          </div>
          <label>
            Something else?
            <input value={other} onChange={(e) => setOther(e.target.value)} maxLength={60} placeholder="e.g. Nurse, chef, photographer, lawyer" />
          </label>
          <div className="flex justify-end">
            <Button disabled={!work.length && !other.trim()} onClick={() => setStep(2)} icon="arrowRight">Continue</Button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-[28px] font-semibold">Where do you post?</h1>
            <p className="m-0 text-muted">Pick the platforms you already use. Nothing is chosen for you, and you can change this any time.</p>
          </div>
          <Panel>
            <label>
              Name to write as
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            </label>
            <div className="flex flex-wrap gap-2">
              {platforms.map((p) => <Chip key={p.id} on={chosen.includes(p.id)} onClick={() => togglePlatform(p.id)}>{p.label}</Chip>)}
            </div>
          </Panel>
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-between gap-3">
            <Button variant="secondary" onClick={() => setStep(1)}>Back</Button>
            <Button disabled={busy || !chosen.length || !name.trim()} onClick={saveVoice}>{busy ? "Saving…" : "Save and continue"}</Button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-[28px] font-semibold">Where does your work live?</h1>
            <p className="m-0 text-muted">Connect one, and ideas start appearing on their own. You can add more later in Sources.</p>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {shown.map((id) => {
              const s = SOURCES[id]!;
              return (
                <li key={id}>
                  <LinkButton to={s.to} variant="secondary" className="!h-auto !w-full !justify-start !whitespace-normal !py-3.5 !text-left">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-raised text-accent-ink"><Icon name={s.icon} size={17} /></span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="font-semibold">{s.name}</span>
                      <span className="text-[13px] font-normal leading-snug text-muted">{s.body}</span>
                    </span>
                    <Icon name="arrowRight" size={16} className="text-muted" />
                  </LinkButton>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap justify-between gap-3">
            <LinkButton to="/app/voice" variant="ghost">Fine-tune my voice</LinkButton>
            <Button onClick={() => navigate("/app")}>I’ll do this later</Button>
          </div>
        </>
      )}
    </div>
  );
}
