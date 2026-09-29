// Browser video renderer (ADR-0006): draws a timeline on a canvas and records it with
// MediaRecorder. Rendering happens on the user's device, so it costs Showrium nothing.

export type Scene =
  | { kind: "title"; heading: string; body?: string; durationMs: number }
  | { kind: "text"; body: string; durationMs: number }
  | { kind: "bullets"; heading?: string; lines: string[]; durationMs: number }
  | { kind: "code"; heading?: string; code: string; durationMs: number }
  | { kind: "quote"; body: string; attribution?: string; durationMs: number }
  | { kind: "outro"; heading: string; body?: string; durationMs: number };
export interface Timeline {
  title: string;
  narration: string;
  aspect: "9:16" | "1:1" | "16:9";
  scenes: Scene[];
}

const THEME = { bg: "#16213A", panel: "#1F2B45", fg: "#F5F6F8", muted: "#AEB8CC", accent: "#E3A443" };
const DISPLAY = '"Bricolage Grotesque", "Segoe UI", system-ui, sans-serif';
const BODY = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, Consolas, monospace';

export function canvasSize(aspect: Timeline["aspect"]) {
  // 720p-class output keeps recording smooth on ordinary laptops and phones.
  return aspect === "9:16" ? { w: 720, h: 1280 } : aspect === "1:1" ? { w: 1080, h: 1080 } : { w: 1280, h: 720 };
}

export const sceneTotal = (t: Timeline) => t.scenes.reduce((s, x) => s + x.durationMs, 0);

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

function drawLines(ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number, lineHeight: number) {
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return y + lines.length * lineHeight;
}

/** Captions: the narration in chunks of up to 6 words, spread evenly over the video. */
export function captionAt(narration: string, fraction: number): string {
  const words = narration.trim().split(/\s+/).filter(Boolean);
  // Even chunks of at most 6 words (13 words → 5, 4, 4), so no caption is a single stray word.
  const count = Math.ceil(words.length / 6);
  const chunks: string[] = [];
  for (let c = 0, i = 0; c < count; c++) {
    const size = Math.ceil((words.length - i) / (count - c));
    chunks.push(words.slice(i, i + size).join(" "));
    i += size;
  }
  if (!chunks.length) return "";
  return chunks[Math.min(chunks.length - 1, Math.floor(Math.max(0, Math.min(0.9999, fraction)) * chunks.length))]!;
}

/** Draws the frame at `tMs`. `totalMs` may be longer than the scenes (to match the voice-over). */
export function drawFrame(ctx: CanvasRenderingContext2D, t: Timeline, tMs: number, totalMs: number) {
  const { width: W, height: H } = ctx.canvas;
  const scale = totalMs / sceneTotal(t);
  const u = Math.min(W, H) / 720; // unit
  const pad = 64 * u;

  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, W, H);

  // Which scene, and how far into it.
  let start = 0;
  let scene = t.scenes[t.scenes.length - 1]!;
  let local = 1;
  for (const s of t.scenes) {
    const d = s.durationMs * scale;
    if (tMs < start + d) {
      scene = s;
      local = (tMs - start) / d;
      break;
    }
    start += d;
  }
  const enter = Math.min(1, local * 6); // quick fade/slide in
  ctx.globalAlpha = enter;
  const slide = (1 - enter) * 30 * u;
  ctx.textBaseline = "top";
  ctx.fillStyle = THEME.fg;
  const maxW = W - pad * 2;
  let y = H * 0.22 + slide;

  const heading = (text: string, size = 64) => {
    ctx.font = `700 ${size * u}px ${DISPLAY}`;
    ctx.fillStyle = THEME.fg;
    y = drawLines(ctx, wrap(ctx, text, maxW), pad, y, size * 1.12 * u) + 24 * u;
  };
  const body = (text: string, size = 38, color = THEME.muted) => {
    ctx.font = `400 ${size * u}px ${BODY}`;
    ctx.fillStyle = color;
    y = drawLines(ctx, wrap(ctx, text, maxW), pad, y, size * 1.35 * u) + 16 * u;
  };

  switch (scene.kind) {
    case "title":
    case "outro":
      ctx.fillStyle = THEME.accent;
      ctx.fillRect(pad, y - 28 * u, 96 * u, 10 * u);
      heading(scene.heading, scene.kind === "title" ? 80 : 68);
      if (scene.body) body(scene.body);
      break;
    case "text":
      body(scene.body, 52, THEME.fg);
      break;
    case "quote":
      ctx.font = `700 ${140 * u}px ${DISPLAY}`;
      ctx.fillStyle = THEME.accent;
      ctx.fillText("“", pad - 8 * u, y - 60 * u);
      y += 70 * u;
      body(scene.body, 50, THEME.fg);
      if (scene.attribution) body(scene.attribution, 32);
      break;
    case "bullets": {
      if (scene.heading) heading(scene.heading, 56);
      const shown = Math.ceil(Math.min(1, local * 1.4) * scene.lines.length);
      ctx.font = `500 ${44 * u}px ${BODY}`;
      scene.lines.slice(0, shown).forEach((line) => {
        ctx.fillStyle = THEME.accent;
        ctx.fillRect(pad, y + 18 * u, 14 * u, 14 * u);
        ctx.fillStyle = THEME.fg;
        y = drawLines(ctx, wrap(ctx, line, maxW - 40 * u), pad + 36 * u, y, 58 * u) + 18 * u;
      });
      break;
    }
    case "code": {
      if (scene.heading) heading(scene.heading, 52);
      const size = 30 * u;
      ctx.font = `400 ${size}px ${MONO}`;
      const lines = scene.code.split("\n");
      const boxH = lines.length * size * 1.5 + 48 * u;
      ctx.fillStyle = THEME.panel;
      ctx.fillRect(pad - 16 * u, y, maxW + 32 * u, boxH);
      const total = scene.code.length;
      let remaining = Math.floor(Math.min(1, local * 1.6) * total); // typewriter
      ctx.fillStyle = THEME.fg;
      lines.forEach((line, i) => {
        const part = line.slice(0, Math.max(0, remaining));
        remaining -= line.length + 1;
        ctx.fillText(part, pad + 8 * u, y + 24 * u + i * size * 1.5);
      });
      y += boxH;
      break;
    }
  }
  ctx.globalAlpha = 1;

  // Progress bar and captions.
  ctx.fillStyle = THEME.accent;
  ctx.fillRect(0, 0, W * Math.min(1, tMs / totalMs), 8 * u);
  const caption = captionAt(t.narration, tMs / totalMs);
  if (caption) drawCaption(ctx, caption, W, H, u, pad, maxW);
}

/**
 * Captions as outlined white text, centred near the bottom: readable on any background without
 * a black box over the video (the owner's request). A dark outline plus a soft shadow does the work.
 */
export function drawCaption(ctx: CanvasRenderingContext2D, caption: string, W: number, H: number, u: number, pad: number, maxW: number) {
  ctx.save();
  ctx.font = `700 ${40 * u}px ${BODY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  const lines = wrap(ctx, caption, maxW);
  const lh = 54 * u;
  const top = H - pad * 2.2 - lines.length * lh;
  lines.forEach((line, i) => {
    const y = top + i * lh;
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 12 * u;
    ctx.lineWidth = 8 * u;
    ctx.strokeStyle = "rgba(10,14,24,0.95)";
    ctx.strokeText(line, W / 2, y);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(line, W / 2, y);
  });
  ctx.restore();
}

/**
 * The recording format. MP4 must carry AAC audio: asking for plain "video/mp4" makes Chrome write
 * Opus inside MP4, which many players and apps play without sound (the owner's report). So:
 * MP4 with AAC when available, then WebM (Opus is normal there), and plain MP4 only where WebM
 * recording isn't available (Safari, whose MP4 uses AAC).
 */
export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "video/webm";
  const aacMp4 = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.4D401E,mp4a.40.2"];
  for (const type of aacMp4) if (MediaRecorder.isTypeSupported(type)) return type;
  for (const type of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) if (MediaRecorder.isTypeSupported(type)) return type;
  return "video/mp4";
}

/** Loudest sample in the file's sound track (0 when silent or unreadable, null when it can't be checked). */
export async function audioPeak(blob: Blob): Promise<number | null> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    let peak = 0;
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i]!));
    }
    return peak;
  } catch {
    return null; // some browsers can't decode their own recordings; don't block the download
  } finally {
    void ctx.close();
  }
}

export async function decodeAudio(base64: string): Promise<AudioBuffer> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(bytes.buffer);
  } finally {
    void ctx.close();
  }
}

/**
 * Plays the timeline on the canvas in real time; optionally records it (with the voice-over).
 * Returns the recorded Blob when `record` is true.
 *
 * Pass `audioContext` created in the click handler: browsers start an AudioContext made outside
 * a user gesture as "suspended", and a suspended context records silence.
 */
export async function play(
  canvas: HTMLCanvasElement,
  t: Timeline,
  opts: { audio?: AudioBuffer | null; audioContext?: AudioContext | null; record?: boolean; onProgress?: (f: number) => void; signal?: AbortSignal },
): Promise<Blob | null> {
  const ctx2d = canvas.getContext("2d")!;
  const audioCtx = opts.audio ? (opts.audioContext ?? new AudioContext()) : null;
  await document.fonts?.ready;
  const totalMs = Math.max(sceneTotal(t), (opts.audio?.duration ?? 0) * 1000 + 600);

  const dest = audioCtx?.createMediaStreamDestination();
  if (audioCtx && audioCtx.state !== "running") await audioCtx.resume().catch(() => undefined);
  if (audioCtx && audioCtx.state !== "running") {
    throw new Error("The browser blocked the sound. Click the button again to record with the voice-over.");
  }

  let recorder: MediaRecorder | null = null;
  const chunks: Blob[] = [];
  if (opts.record) {
    const stream = canvas.captureStream(30);
    dest?.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType(), videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start(250);
  }
  // Start the voice-over only once recording is running, so its first words aren't cut off.
  if (audioCtx && opts.audio && dest) {
    const src = audioCtx.createBufferSource();
    src.buffer = opts.audio;
    src.connect(dest);
    src.connect(audioCtx.destination);
    src.start(audioCtx.currentTime + 0.3);
  }

  // Frames are timed by the clock with a timer, not animation frames: animation frames stop
  // whenever the window isn't being painted (behind another window, screen off), which would
  // stall a recording. Timers keep running (throttled in background tabs).
  const started = performance.now();
  await new Promise<void>((resolve) => {
    const frame = () => {
      const elapsed = performance.now() - started;
      if (opts.signal?.aborted || elapsed >= totalMs) return resolve();
      drawFrame(ctx2d, t, elapsed, totalMs);
      opts.onProgress?.(elapsed / totalMs);
      setTimeout(frame, 1000 / 30);
    };
    frame();
  });
  drawFrame(ctx2d, t, totalMs - 1, totalMs);

  let blob: Blob | null = null;
  if (recorder) {
    const rec = recorder;
    const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
    rec.stop();
    await done;
    blob = new Blob(chunks, { type: rec.mimeType.split(";")[0] ?? "video/webm" });
  }
  // Close the sound only after the recorder has its last chunk (closing first can drop the tail).
  if (audioCtx && !opts.audioContext) void audioCtx.close();
  return blob;
}
