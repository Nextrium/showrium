import { useEffect, useState, type FormEvent } from "react";
import { api, useApi } from "../../lib";
import { usePlatforms, type Persona, type Platform } from "./shared";

const BLOCKERS = [
  "I don't know what's worth sharing",
  "I don't want to sound like I'm bragging",
  "I don't have time",
  "Every platform wants something different",
  "I have no photos or video",
  "I worry about what people will think",
];

const csv = (v: FormDataEntryValue | null) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export function VoicePage() {
  const { data, reload } = useApi<{ persona: Persona | null }>("/persona");
  const platforms = usePlatforms();
  const [chosen, setChosen] = useState<Platform[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = data?.persona;

  useEffect(() => {
    if (p) setChosen(p.platforms);
  }, [p]);

  if (!data) return <p className="note">Loading…</p>;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setSaved(false);
    try {
      await api("/persona", {
        method: "PUT",
        body: JSON.stringify({
          displayName: String(f.get("displayName")),
          role: String(f.get("role") ?? ""),
          expertise: csv(f.get("expertise")),
          interests: csv(f.get("interests")),
          audience: String(f.get("audience") ?? ""),
          voice: String(f.get("voice") ?? ""),
          avoid: csv(f.get("avoid")),
          blockers: f.getAll("blockers").map(String),
          platforms: chosen,
          monetizationSafe: f.get("monetizationSafe") === "on",
        }),
      });
      setSaved(true);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    }
  };

  return (
    <section className="card">
      <h3>Your voice</h3>
      <p className="note">This is how Showrium writes as you. Only the platforms you pick are used; nothing is chosen for you.</p>
      <form className="form" onSubmit={submit}>
        <label>Name to write as<input id="displayName" name="displayName" required maxLength={80} defaultValue={p?.displayName ?? ""} /></label>
        <label>What you do<input id="role" name="role" maxLength={120} defaultValue={p?.role ?? ""} placeholder="e.g. Backend engineer, bakery owner, student" /></label>
        <label>What you know well (comma-separated)<input id="expertise" name="expertise" defaultValue={p?.expertise.join(", ") ?? ""} /></label>
        <label>What you're into (comma-separated)<input id="interests" name="interests" defaultValue={p?.interests.join(", ") ?? ""} /></label>
        <label>Who you're talking to<input id="audience" name="audience" maxLength={300} defaultValue={p?.audience ?? ""} /></label>
        <label>How you sound<input id="voice" name="voice" maxLength={500} defaultValue={p?.voice ?? ""} placeholder="e.g. warm, plain, a little funny, no hype" /></label>
        <label>Never write about (comma-separated)<input id="avoid" name="avoid" defaultValue={p?.avoid.join(", ") ?? ""} /></label>
        <fieldset className="fieldset">
          <legend>What has stopped you posting?</legend>
          {BLOCKERS.map((b) => (
            <label key={b} className="check"><input type="checkbox" name="blockers" value={b} defaultChecked={p?.blockers.includes(b)} />{b}</label>
          ))}
        </fieldset>
        <fieldset className="fieldset">
          <legend>Platforms you already use</legend>
          <div className="chips">
            {platforms.map((pl) => (
              <label key={pl.id} className="check chip-check">
                <input
                  type="checkbox"
                  checked={chosen.includes(pl.id)}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, pl.id] : chosen.filter((x) => x !== pl.id))}
                />
                {pl.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="check">
          <input type="checkbox" name="monetizationSafe" defaultChecked={p?.monetizationSafe} />
          Monetization-safe mode: every post needs my approval, no autopilot, and X posts go through my own X app.
        </label>
        <button className="button">Save my voice</button>
        {saved && <p className="note" role="status">Saved.</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </section>
  );
}
