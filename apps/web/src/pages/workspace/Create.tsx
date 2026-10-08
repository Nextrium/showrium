import { useEffect, useRef, useState } from "react";
import { Link } from "../../App";
import { api, useApi } from "../../lib";
import { DraftCard, THREAD_PLATFORMS } from "./Drafts";
import { MODES, usePlatforms, type Draft, type Persona, type Platform } from "./shared";
import { PageHeader } from "../../ui/kit";
import { QUICK_KEY } from "./Home";
import { UploadForm } from "../../components/UploadForm";
import { ResearchNotes } from "../../components/ResearchNotes";

/** Text typed on Home's "What did you work on?" box carries over once. */
function takeQuickNote(): string {
  try {
    const v = sessionStorage.getItem(QUICK_KEY) ?? "";
    sessionStorage.removeItem(QUICK_KEY);
    return v.trim();
  } catch {
    return "";
  }
}

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
  const [quick] = useState(takeQuickNote);
  const quickIsLink = /^https?:\/\/\S+$/.test(quick);
  const [input, setInput] = useState<"text" | "ask" | "link" | "voice" | "file">(quickIsLink ? "link" : "text");
  const [contextId, setContextId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("context"));
  // What's typed on the "Write or paste" and "From a link" tabs. It's saved as material when
  // "Write posts" is pressed (one click), unless an earlier item is picked instead.
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(quickIsLink ? "" : quick);
  const [url, setUrl] = useState(quickIsLink ? quick : "");
  // A voice note's transcript is put in the text box to check and edit before anything is written.
  const [fromVoice, setFromVoice] = useState(false);
  const [voiceHint, setVoiceHint] = useState("");
  const [voiceNote, setVoiceNote] = useState<{ unclear: string | null; heard: string } | null>(null);
  // "Ask the AI": the person's own instruction (followed), plus optional instructions for other material.
  const [request, setRequest] = useState("");
  const [instructions, setInstructions] = useState("");
  const [stance, setStance] = useState<"own" | "other">("own");
  const [research, setResearch] = useState(false);
  const [mode, setMode] = useState<(typeof MODES)[number]["id"] | "auto">("build_in_public");
  const [chosen, setChosen] = useState<Platform[]>([]);
  const [thread, setThread] = useState(false);
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
      <section className="card max-w-xl">
        <h2 className="h3">First, your voice</h2>
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

  /** Typing new material replaces whatever was chosen before. */
  const typed = (fn: () => void) => {
    fn();
    setContextId(null);
  };
  const typedText = input === "text" && body.trim().length > 0;
  const typedLink = input === "link" && url.trim().length > 0;
  const typedRequest = input === "ask" && request.trim().length > 0;
  /** Why "Write posts" can't run yet, in words (null when it can). */
  const missing = (() => {
    if (contextId) return null;
    if (typedText && voiceNote?.unclear && body === voiceNote.heard) return "Fix the unclear parts of the transcript first.";
    if (typedText) return body.trim().length < 10 ? "Write at least 10 characters." : null;
    if (typedLink) return /^https?:\/\/\S+\.\S+/.test(url.trim()) ? null : "Enter a full link, starting with https://";
    if (typedRequest) return request.trim().length < 10 ? "Tell the AI a little more (at least 10 characters)." : null;
    if (input === "ask") return "Tell the AI what to write first.";
    return input === "voice" ? "Record or upload a voice note first." : input === "file" ? "Upload a photo or document first." : input === "link" ? "Paste a link first." : "Write or paste something first.";
  })();

  /** Saves what's typed as material (once), and returns its id. */
  const saveTyped = async (): Promise<string> => {
    if (contextId) return contextId;
    const created = typedLink
      ? await api<{ id: string }>("/contexts", { method: "POST", body: JSON.stringify({ kind: "url", url: url.trim() }) })
      : typedRequest
        ? await api<{ id: string }>("/contexts", { method: "POST", body: JSON.stringify({ kind: "request", body: request.trim() }) })
        : await api<{ id: string }>("/contexts", { method: "POST", body: JSON.stringify({ kind: fromVoice ? "voice" : "manual", title: title.trim(), body: body.trim() }) });
    setContextId(created.id);
    contexts.reload();
    return created.id;
  };
  const sendAudio = (blob: Blob) =>
    run("Transcribing…", async () => {
      if (blob.size > 2_000_000) throw new Error("Keep voice notes under about 2 minutes (2 MB).");
      const out = await api<{ text: string; unclear: string | null }>("/contexts/voice", {
        method: "POST",
        body: JSON.stringify({ audioBase64: await toBase64(blob), title: "Voice note", hint: voiceHint, save: false }),
      });
      setBody(out.text);
      setTitle((t) => t || "Voice note");
      setFromVoice(true);
      setVoiceNote({ unclear: out.unclear, heard: out.text });
      setContextId(null);
      setInput("text");
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
    run(typedLink && !contextId ? "Reading the page…" : "Writing your posts…", async () => {
      const id = await saveTyped();
      setBusy("Writing your posts…");
      if (research) setBusy("Searching the web…");
      const out = await api<{ drafts: Draft[] }>("/compose", {
        method: "POST",
        body: JSON.stringify({
          contextItemId: id,
          mode,
          platforms: chosen,
          thread: thread && threadable.length > 0,
          ...(input !== "ask" && instructions.trim() ? { instructions: instructions.trim() } : {}),
          stance,
          research,
        }),
      });
      setDrafts(out.drafts);
    });

  const selected = contexts.data?.data.find((c) => c.id === contextId);
  const threadable = chosen.filter((p) => THREAD_PLATFORMS.includes(p));

  return (
    <div className="dash">
      <PageHeader title="New post" subtitle="One input becomes a post for each platform you choose, in your voice." />
      <section className="card">
        <h2 className="h3">1. What do you want to share?</h2>
        <div className="tabs small" role="tablist">
          {(["text", "ask", "link", "voice", "file"] as const).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={input === k}
              className={`tab${input === k ? " active" : ""}`}
              onClick={() => {
                setInput(k);
                if (k === "ask" && mode === "build_in_public") setMode("auto");
              }}
            >
              {k === "text" ? "Write or paste" : k === "ask" ? "Ask the AI" : k === "link" ? "From a link" : k === "voice" ? "Voice note" : "Photo or document"}
            </button>
          ))}
        </div>
        {input === "text" && (
          <div className="form">
            <label>Title (optional)<input id="ctx-title" name="title" maxLength={300} value={title} onChange={(e) => typed(() => setTitle(e.target.value))} /></label>
            {voiceNote && (
              <p className={voiceNote.unclear ? "error" : "note"} role="status">
                {voiceNote.unclear
                  ? `${voiceNote.unclear} Fix the text below (or record again) before writing.`
                  : "Here's what we heard. Check names and numbers, fix anything wrong, then write."}
              </p>
            )}
            <label>
              Your notes, update or idea
              <textarea
                id="ctx-body"
                name="body"
                minLength={10}
                maxLength={20000}
                rows={6}
                value={body}
                onChange={(e) =>
                  typed(() => {
                    setBody(e.target.value);
                    if (!e.target.value.trim()) {
                      setFromVoice(false);
                      setVoiceNote(null);
                    }
                  })
                }
              />
            </label>
          </div>
        )}
        {input === "ask" && (
          <div className="form">
            <label>
              What should the post be about?
              <textarea
                id="ask-request"
                maxLength={4000}
                rows={6}
                value={request}
                onChange={(e) => typed(() => setRequest(e.target.value))}
                placeholder={"e.g. Write an expert view on the Lagos Life game by Shalom, a UK-based Nigerian developer: the criticism and the support.\nFacts I know: she has 10 years in software, and turned down a $100K offer."}
              />
            </label>
            <p className="note">The AI follows this. Add the facts you know; switch on web research below to find more, with sources.</p>
          </div>
        )}
        {input === "link" && (
          <div className="form">
            <label>Link to a blog post, article or page<input id="ctx-url" name="url" type="url" placeholder="https://" value={url} onChange={(e) => typed(() => setUrl(e.target.value))} /></label>
          </div>
        )}
        {input === "voice" && (
          <div className="form">
            <label>
              Names or words in your note (optional)
              <input id="voice-hint" maxLength={300} placeholder="e.g. LagosLife, Shalom, Supabase" value={voiceHint} onChange={(e) => setVoiceHint(e.target.value)} />
            </label>
            <p className="note">Helps us spell them right. You'll see the transcript and can edit it before anything is written.</p>
            <button className="button secondary" onClick={toggleRecording} disabled={Boolean(busy) && !recording}>
              {recording ? "Stop recording" : "Record a voice note (up to 2 min)"}
            </button>
            <label>Or upload audio<input id="ctx-audio" type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && void sendAudio(e.target.files[0])} /></label>
          </div>
        )}
        {input === "file" && (
          <UploadForm
            compact
            onUploaded={(item) => {
              setContextId(item.id);
              contexts.reload();
            }}
          />
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
        <h2 className="h3">2. How and where</h2>
        {input !== "ask" && (
          <label>
            Instructions for the AI (optional)
            <textarea id="ai-instructions" maxLength={4000} rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Focus on what beginners can learn from this. Keep it under 150 words." />
          </label>
        )}
        <fieldset className="chips" aria-label="Whose work is this about?">
          <label className="check chip-check">
            <input type="radio" name="stance" checked={stance === "own"} onChange={() => setStance("own")} />
            About my own work
          </label>
          <label className="check chip-check">
            <input type="radio" name="stance" checked={stance === "other"} onChange={() => setStance("other")} />
            My view on someone else's work
          </label>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} />
          Research the web for facts and sources first (uses one of this month's web researches)
        </label>
        <div className="chips">
          <label className="check chip-check" title="The AI picks the style that fits">
            <input type="radio" name="mode" checked={mode === "auto"} onChange={() => setMode("auto")} />
            Let the AI choose
          </label>
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
        {threadable.length > 0 && (
          <label className="check">
            <input type="checkbox" checked={thread} onChange={(e) => setThread(e.target.checked)} />
            Write as a thread on {threadable.map((p) => platforms.find((x) => x.id === p)?.label ?? p).join(", ")}
          </label>
        )}
        <button className="button" onClick={generate} disabled={Boolean(missing) || !chosen.length || Boolean(busy)} aria-describedby="write-why">
          {busy ?? `Write ${chosen.length} post${chosen.length === 1 ? "" : "s"}`}
        </button>
        {!busy && (missing || !chosen.length) && <p className="note" id="write-why">{missing ?? "Choose at least one platform."}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {drafts.length > 0 && (
        <section className="dash">
          <h2 className="h3">Your drafts</h2>
          <ResearchNotes source={drafts[0]?.source} />
          {drafts.map((d) => (
            <DraftCard key={d.id} draft={d} onChange={(u) => setDrafts(drafts.map((x) => (x.id === u.id ? u : x)))} />
          ))}
        </section>
      )}
    </div>
  );
}
