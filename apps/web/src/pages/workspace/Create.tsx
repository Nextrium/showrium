import { useEffect, useRef, useState } from "react";
import { Link } from "../../App";
import { api, useApi } from "../../lib";
import { DraftCard } from "./Drafts";
import { MODES, usePlatforms, type Draft, type Persona, type Platform } from "./shared";

type ContextItem = { id: string; kind: string; title: string; body: string; url: string | null; createdAt: string };

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Couldn't read the recording."));
    reader.readAsDataURL(blob);
  });
}

export function CreatePage() {
  const { data: personaData } = useApi<{ persona: Persona | null }>("/persona");
  const contexts = useApi<{ data: ContextItem[] }>("/contexts");
  const platforms = usePlatforms();
  const [input, setInput] = useState<"text" | "link" | "voice">("text");
  const [contextId, setContextId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("context"));
  const [mode, setMode] = useState<(typeof MODES)[number]["id"]>("build_in_public");
  const [chosen, setChosen] = useState<Platform[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);

  const persona = personaData?.persona;
  useEffect(() => {
    if (persona) setChosen(persona.platforms);
  }, [persona]);

  if (personaData && !persona) {
    return (
      <section className="card">
        <h3>First, your voice</h3>
        <p className="note">Tell Showrium a little about you, so posts sound like you and only go where you already are.</p>
        <Link to="/app/voice" className="button">Set up my voice</Link>
      </section>
    );
  }

  const run = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const addText = (form: HTMLFormElement) => {
    const f = new FormData(form);
    return run("Saving…", async () => {
      const created = await api<{ id: string }>("/contexts", { method: "POST", body: JSON.stringify({ kind: "manual", title: String(f.get("title") ?? ""), body: String(f.get("body")) }) });
      setContextId(created.id);
      contexts.reload();
    });
  };
  const addLink = (form: HTMLFormElement) => {
    const f = new FormData(form);
    return run("Reading the page…", async () => {
      const created = await api<{ id: string }>("/contexts", { method: "POST", body: JSON.stringify({ kind: "url", url: String(f.get("url")) }) });
      setContextId(created.id);
      contexts.reload();
    });
  };
  const sendAudio = (blob: Blob) =>
    run("Transcribing…", async () => {
      if (blob.size > 2_000_000) throw new Error("Keep voice notes under about 2 minutes (2 MB).");
      const created = await api<{ id: string }>("/contexts/voice", { method: "POST", body: JSON.stringify({ audioBase64: await toBase64(blob), title: "Voice note" }) });
      setContextId(created.id);
      contexts.reload();
    });

  const toggleRecording = async () => {
    if (recording) {
      recorder.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void sendAudio(new Blob(chunks, { type: rec.mimeType }));
      };
      rec.start();
      recorder.current = rec;
      setRecording(true);
      window.setTimeout(() => rec.state === "recording" && rec.stop(), 120_000);
    } catch {
      setError("Microphone access was blocked. You can upload an audio file instead.");
    }
  };

  const generate = () =>
    run("Writing your posts…", async () => {
      const out = await api<{ drafts: Draft[] }>("/compose", { method: "POST", body: JSON.stringify({ contextItemId: contextId, mode, platforms: chosen }) });
      setDrafts(out.drafts);
    });

  const selected = contexts.data?.data.find((c) => c.id === contextId);

  return (
    <div className="dash">
      <section className="card">
        <h3>1. What do you want to share?</h3>
        <div className="tabs small" role="tablist">
          {(["text", "link", "voice"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={input === k} className={`tab${input === k ? " active" : ""}`} onClick={() => setInput(k)}>
              {k === "text" ? "Write or paste" : k === "link" ? "From a link" : "Voice note"}
            </button>
          ))}
        </div>
        {input === "text" && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void addText(e.currentTarget); }}>
            <label>Title (optional)<input id="ctx-title" name="title" maxLength={300} /></label>
            <label>Your notes, update or idea<textarea id="ctx-body" name="body" required minLength={10} maxLength={20000} rows={6} /></label>
            <button className="button secondary" disabled={Boolean(busy)}>Use this</button>
          </form>
        )}
        {input === "link" && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void addLink(e.currentTarget); }}>
            <label>Link to a blog post, article or page<input id="ctx-url" name="url" type="url" required placeholder="https://" /></label>
            <button className="button secondary" disabled={Boolean(busy)}>Read it</button>
          </form>
        )}
        {input === "voice" && (
          <div className="form">
            <button className="button secondary" onClick={toggleRecording} disabled={Boolean(busy) && !recording}>
              {recording ? "Stop recording" : "Record a voice note (up to 2 min)"}
            </button>
            <label>Or upload audio<input id="ctx-audio" type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && void sendAudio(e.target.files[0])} /></label>
          </div>
        )}
        {contexts.data && contexts.data.data.length > 0 && (
          <label>
            Or pick something you added before
            <select id="ctx-pick" value={contextId ?? ""} onChange={(e) => setContextId(e.target.value || null)}>
              <option value="">Choose…</option>
              {contexts.data.data.map((c) => (
                <option key={c.id} value={c.id}>{(c.title || c.body).slice(0, 80)}</option>
              ))}
            </select>
          </label>
        )}
        {selected && <p className="note">Using: <strong>{(selected.title || selected.body).slice(0, 120)}</strong></p>}
      </section>

      <section className="card">
        <h3>2. How and where</h3>
        <div className="chips">
          {MODES.map((m) => (
            <label key={m.id} className="check chip-check" title={m.hint}>
              <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
              {m.label}
            </label>
          ))}
        </div>
        <div className="chips">
          {platforms.filter((p) => persona?.platforms.includes(p.id)).map((p) => (
            <label key={p.id} className="check chip-check">
              <input type="checkbox" checked={chosen.includes(p.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id))} />
              {p.label}
            </label>
          ))}
        </div>
        <button className="button" onClick={generate} disabled={!contextId || !chosen.length || Boolean(busy)}>
          {busy ?? `Write ${chosen.length} post${chosen.length === 1 ? "" : "s"}`}
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {drafts.length > 0 && (
        <section className="dash">
          <h3>Your drafts</h3>
          {drafts.map((d) => (
            <DraftCard key={d.id} draft={d} onChange={(u) => setDrafts(drafts.map((x) => (x.id === u.id ? u : x)))} />
          ))}
        </section>
      )}
    </div>
  );
}
