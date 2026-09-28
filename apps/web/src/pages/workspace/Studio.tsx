import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, formatDate, orgHeaders, useApi } from "../../lib";
import { canvasSize, decodeAudio, drawFrame, play, sceneTotal, type Timeline } from "../../video/render";
import type { Draft } from "./shared";
import { PageHeader } from "../../ui/kit";

type Video = { id: string; timeline: Timeline; revisions: number; createdAt: string };
type Connection = { id: string; platform: string; handle: string; status: string };

function Player({ video, onRevised }: { video: Video; onRevised: (v: Video) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [audio, setAudio] = useState<AudioBuffer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState<{ url: string; blob: Blob } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: conns } = useApi<{ data: Connection[] }>("/connections");
  const tiktok = conns?.data.find((c) => c.platform === "tiktok" && c.status === "active");
  const size = canvasSize(video.timeline.aspect);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (ctx) drawFrame(ctx, video.timeline, 1200, sceneTotal(video.timeline));
  }, [video]);
  useEffect(() => () => {
    if (file) URL.revokeObjectURL(file.url);
  }, [file]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const voice = () =>
    run("Creating the voice-over…", async () => {
      const out = await api<{ audioBase64: string }>(`/videos/${video.id}/voiceover`, { method: "POST" });
      setAudio(await decodeAudio(out.audioBase64));
      setMessage("Voice-over added.");
    });
  const preview = () => run("Playing…", async () => void (await play(canvas.current!, video.timeline, { audio, onProgress: setProgress })));
  const record = () =>
    run("Recording the video (plays in real time)…", async () => {
      const blob = await play(canvas.current!, video.timeline, { audio, record: true, onProgress: setProgress });
      if (blob) setFile({ blob, url: URL.createObjectURL(blob) });
    });
  const revise = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const instruction = String(new FormData(form).get("instruction"));
    return run("Updating the plan…", async () => {
      const out = await api<Video>(`/videos/${video.id}/revise`, { method: "POST", body: JSON.stringify({ instruction }) });
      form.reset();
      setAudio(null);
      setFile(null);
      onRevised(out);
    });
  };
  const toTikTok = () =>
    run("Sending to TikTok…", async () => {
      if (!file || !tiktok) return;
      const res = await fetch(`/api/v1/videos/${video.id}/tiktok-inbox?connectionId=${tiktok.id}`, { method: "POST", headers: { "Content-Type": file.blob.type, ...orgHeaders() }, body: file.blob });
      const body = (await res.json().catch(() => null)) as { message?: string; error?: { message: string } } | null;
      if (!res.ok) throw new Error(body?.error?.message ?? "Upload failed.");
      setMessage(body?.message ?? "Sent to your TikTok inbox.");
    });

  const ext = file?.blob.type.includes("mp4") ? "mp4" : "webm";
  return (
    <section className="card">
      <h3>{video.timeline.title}</h3>
      <div className="studio">
        <canvas ref={canvas} width={size.w} height={size.h} className="studio-canvas" aria-label="Video preview" />
        <div className="form">
          <p className="note">{video.timeline.scenes.length} scenes · about {Math.round(sceneTotal(video.timeline) / 1000)} s · faceless explainer</p>
          <div className="row">
            <button className="button secondary" disabled={Boolean(busy)} onClick={voice}>{audio ? "Voice-over ready" : "Add voice-over"}</button>
            <button className="button secondary" disabled={Boolean(busy)} onClick={preview}>Preview</button>
            <button className="button" disabled={Boolean(busy)} onClick={record}>Make the video file</button>
          </div>
          {busy && <p className="note" role="status">{busy} {Math.round(progress * 100)}%</p>}
          {busy?.startsWith("Recording") && <p className="note">Keep this tab open and visible while recording. Browsers slow down background tabs, which makes the video choppy.</p>}
          {file && (
            <div className="row">
              <a className="button" href={file.url} download={`showrium-${video.id}.${ext}`}>Download ({(file.blob.size / 1e6).toFixed(1)} MB)</a>
              {tiktok && <button className="button secondary" disabled={Boolean(busy)} onClick={toTikTok}>Send to TikTok inbox</button>}
            </div>
          )}
          <form className="row" onSubmit={revise}>
            <label>Change something<input name="instruction" required minLength={3} maxLength={500} placeholder="e.g. make the intro shorter, add a scene about the dead-letter queue" /></label>
            <button className="button secondary" disabled={Boolean(busy)}>Apply</button>
          </form>
          <details>
            <summary className="note">Narration script</summary>
            <p className="note">{video.timeline.narration}</p>
          </details>
          <p className="note">This is an AI-assisted, template-based video with no realistic people, so platforms don't require an AI label. Use the platform's AI label if you add realistic AI footage.</p>
          {message && <p className="note" role="status">{message}</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  );
}

export function StudioPage() {
  const videos = useApi<{ data: Video[]; premium: { avatar: boolean; cinematic: boolean } }>("/videos");
  const drafts = useApi<{ data: Draft[] }>("/drafts");
  const [open, setOpen] = useState<Video | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const v = await api<Video>("/videos", { method: "POST", body: JSON.stringify({ draftId: String(f.get("draftId")), aspect: String(f.get("aspect")) }) });
      setOpen(v);
      videos.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't plan the video.");
    } finally {
      setBusy(false);
    }
  };

  const candidates = (drafts.data?.data ?? []).filter((d) => d.status !== "discarded");
  return (
    <div className="dash">
      <PageHeader title="Video" subtitle="Turn a post into a short explainer with captions and a voice-over, made on your device." />
      <section className="card">
        <h3>Make a video</h3>
        <p className="note">Turn a post into a short explainer with captions and an AI voice-over. It's made on your device, so it's quick and free to render.</p>
        <form className="row" onSubmit={create}>
          <label>
            From post
            <select name="draftId" required>
              {candidates.map((d) => <option key={d.id} value={d.id}>{d.platform}: {d.text.slice(0, 60)}</option>)}
            </select>
          </label>
          <label>
            Shape
            <select name="aspect" defaultValue="9:16">
              <option value="9:16">Vertical 9:16 (TikTok, Reels, Shorts)</option>
              <option value="1:1">Square 1:1 (feed)</option>
              <option value="16:9">Wide 16:9 (LinkedIn, X)</option>
            </select>
          </label>
          <button className="button" disabled={busy || !candidates.length}>{busy ? "Planning…" : "Plan the video"}</button>
        </form>
        {!candidates.length && <p className="note">Create a post first, then turn it into a video.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <p className="note">
          Talking-avatar and cinematic AI clips: {videos.data?.premium.avatar || videos.data?.premium.cinematic ? "available with credits." : "coming soon."}
        </p>
      </section>
      {open && <Player video={open} onRevised={setOpen} />}
      <section className="card">
        <h3>Your videos</h3>
        <ul className="items">
          {videos.data?.data.map((v) => (
            <li key={v.id}>
              <button className="button secondary" onClick={() => setOpen(v)}>Open</button> {v.timeline.title} <span className="muted">· {v.timeline.aspect} · {formatDate(v.createdAt)}</span>
            </li>
          ))}
          {videos.data?.data.length === 0 && <li className="muted">No videos yet.</li>}
        </ul>
      </section>
    </div>
  );
}
