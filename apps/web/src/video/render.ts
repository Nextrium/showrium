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
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 6) chunks.push(words.slice(i, i + 6).join(" "));
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
      if (scene.attribution) body(`— ${scene.attribution}`, 32);
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
  if (caption) {
    ctx.font = `600 ${36 * u}px ${BODY}`;
    const lines = wrap(ctx, caption, maxW);
    const lh = 48 * u;
    const top = H - pad * 2.2 - lines.length * lh;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(pad - 16 * u, top - 12 * u, maxW + 32 * u, lines.length * lh + 24 * u);
    ctx.fillStyle = "#FFFFFF";
    drawLines(ctx, lines, pad, top, lh);
  }
}

export function pickMimeType(): string {
  for (const type of ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "video/webm";
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
 */
export async function play(
  canvas: HTMLCanvasElement,
  t: Timeline,
  opts: { audio?: AudioBuffer | null; record?: boolean; onProgress?: (f: number) => void; signal?: AbortSignal },
): Promise<Blob | null> {
  const ctx2d = canvas.getContext("2d")!;
  await document.fonts?.ready;
  const totalMs = Math.max(sceneTotal(t), (opts.audio?.duration ?? 0) * 1000 + 600);

  const audioCtx = opts.audio ? new AudioContext() : null;
  const dest = audioCtx?.createMediaStreamDestination();
  if (audioCtx && opts.audio && dest) {
    const src = audioCtx.createBufferSource();
    src.buffer = opts.audio;
    src.connect(dest);
    src.connect(audioCtx.destination);
    src.start(audioCtx.currentTime + 0.3);
  }

  let recorder: MediaRecorder | null = null;
  const chunks: Blob[] = [];
  if (opts.record) {
    const stream = canvas.captureStream(30);
    dest?.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
    recorder = new MediaRecorder(stream, { mimeType: pickMimeType(), videoBitsPerSecond: 4_000_000 });
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.start(250);
  }

  // Frames are timed by the clock, not by animation frames: animation frames stop when the
  // tab is hidden, which would stall a recording. Timers keep running (throttled) in the background.
  const started = performance.now();
  await new Promise<void>((resolve) => {
    const frame = () => {
      const elapsed = performance.now() - started;
      if (opts.signal?.aborted || elapsed >= totalMs) return resolve();
      drawFrame(ctx2d, t, elapsed, totalMs);
      opts.onProgress?.(elapsed / totalMs);
      if (document.hidden) setTimeout(frame, 33);
      else requestAnimationFrame(frame);
    };
    frame();
  });
  drawFrame(ctx2d, t, totalMs - 1, totalMs);
  void audioCtx?.close();

  if (!recorder) return null;
  const rec = recorder;
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  rec.stop();
  await done;
  return new Blob(chunks, { type: rec.mimeType.split(";")[0] ?? "video/webm" });
}
