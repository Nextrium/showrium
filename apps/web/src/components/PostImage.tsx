// A post's images (up to 4). Posts written from the same material share them, unless a post
// switches to its own. Cards and crops are made here, in the browser (free), and uploaded; a crop
// is always made from the original at full resolution, and the original is kept. Finding one (the
// link's preview image, a screenshot, AI) happens on the server.
import { useEffect, useRef, useState } from "react";
import { api, dataChanged, orgHeaders, useApi, useEditable } from "../lib";
import { prepareForPosting } from "../photos";
import { Alert, Button, Chip, Loading, Panel, SaveBar, Switch } from "../ui/kit";
import type { Draft, DraftImage, Persona, Platform } from "../pages/workspace/shared";

export type ImageSize = "square" | "portrait" | "landscape" | "none";
type Shape = Exclude<ImageSize, "none">;
type Settings = { sizes: Partial<Record<Platform, ImageSize>>; auto: boolean; allowAi: boolean };

export const SIZE_PIXELS: Record<Shape, { w: number; h: number; label: string }> = {
  square: { w: 1080, h: 1080, label: "Square (1:1)" },
  portrait: { w: 1080, h: 1350, label: "Portrait (4:5)" },
  landscape: { w: 1200, h: 675, label: "Landscape (16:9)" },
};
const MAX_IMAGES = 4;
const MAX_UPLOAD = 5 * 1024 * 1024;
const SOURCE_LABELS: Record<string, string> = {
  upload: "Your photo",
  link: "From the link",
  screenshot: "Screenshot of the page",
  card: "Designed card",
  ai: "AI-generated",
};

function canvasBlob(canvas: HTMLCanvasElement, quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the image."))), "image/jpeg", quality));
}

/**
 * Crops the original to a shape, centred, keeping every pixel it can: the largest area of that
 * shape inside the original, at the original's resolution (never scaled up). Only a very large
 * result is scaled down, so it stays under the upload limit.
 */
export async function cropToSize(original: Blob, size: Shape): Promise<Blob> {
  const ratio = SIZE_PIXELS[size].w / SIZE_PIXELS[size].h;
  const bitmap = await createImageBitmap(original);
  const sw = Math.min(bitmap.width, Math.round(bitmap.height * ratio));
  const sh = Math.min(bitmap.height, Math.round(bitmap.width / ratio));
  const sx = Math.round((bitmap.width - sw) / 2);
  const sy = Math.round((bitmap.height - sh) / 2);
  for (const longest of [Infinity, 4096, 3072, 2048]) {
    const scale = Math.min(1, longest / Math.max(sw, sh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; // JPEG has no transparency
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas);
    if (blob.size <= MAX_UPLOAD) return blob;
  }
  throw new Error("This image is too large to crop. Try a smaller one.");
}

/** The first sentence or line of the post, for a card. */
export function cardLine(text: string): string {
  const first = text.replace(/https?:\/\/\S+/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const sentence = first.match(/^.{20,220}?[.!?](\s|$)/)?.[0] ?? first;
  return sentence.trim().slice(0, 220);
}

/** A designed card: the post's key line on a calm background, with the author's name. No Showrium branding. */
export async function makeCard(text: string, author: string, size: Shape): Promise<Blob> {
  const { w, h } = SIZE_PIXELS[size];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  await document.fonts?.ready;
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, "#16213A");
  grad.addColorStop(1, "#23345A");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const pad = Math.round(w * 0.08);
  ctx.fillStyle = "#E3A443";
  ctx.fillRect(pad, pad, Math.round(w * 0.09), Math.round(w * 0.012));
  // Largest font size (from big to small) at which the line fits in the box.
  const line = cardLine(text) || text.slice(0, 200);
  const maxW = w - pad * 2;
  const maxH = h - pad * 3.4;
  let fontSize = Math.round(w * 0.075);
  let lines: string[] = [];
  for (; fontSize >= 28; fontSize -= 4) {
    ctx.font = `700 ${fontSize}px "Bricolage Grotesque", "Segoe UI", system-ui, sans-serif`;
    lines = [];
    let cur = "";
    for (const word of line.split(/\s+/)) {
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = word;
      } else cur = test;
    }
    if (cur) lines.push(cur);
    if (lines.length * fontSize * 1.18 <= maxH) break;
  }
  ctx.fillStyle = "#F5F6F8";
  ctx.textBaseline = "top";
  const top = pad * 1.9;
  lines.forEach((l, i) => ctx.fillText(l, pad, top + i * fontSize * 1.18));
  ctx.font = `500 ${Math.round(w * 0.032)}px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif`;
  ctx.fillStyle = "#AEB8CC";
  ctx.textBaseline = "bottom";
  ctx.fillText(author.slice(0, 60), pad, h - pad);
  return canvasBlob(canvas);
}

/** Whether an image already has a shape's proportions (within 2%). */
const fitsShape = (f: { width?: number; height?: number }, size: Shape) =>
  Boolean(f.width && f.height && Math.abs(f.width / f.height - SIZE_PIXELS[size].w / SIZE_PIXELS[size].h) < 0.02);

/** The file a platform gets for an image: its crop for the shape if one was made, else the original. */
export const fileSize = (img: DraftImage, size: ImageSize): Shape | "original" => (size !== "none" && img.variants[size] ? size : "original");

async function send(path: string, method: "POST" | "PUT", blob: Blob, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", blob, blob.type === "image/png" ? "image.png" : "image.jpg");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const res = await fetch(`/api/v1${path}`, { method, headers: orgHeaders(), body: form });
  const out = (await res.json().catch(() => null)) as { error?: { message: string } } | null;
  if (!res.ok) throw new Error(out?.error?.message ?? `Couldn't save the image (${res.status}).`);
}

/** An image file, fetched with the workspace header (an <img> tag can't send it). */
export async function fetchImage(id: string, size: Shape | "original"): Promise<Blob> {
  const res = await fetch(`/api/v1/images/${encodeURIComponent(id)}?size=${size}`, { headers: orgHeaders() });
  if (!res.ok) throw new Error("Couldn't load the image.");
  return res.blob();
}

export type ImageFileForPosting = { image: DraftImage; file: File; url: string };

/** The files of a post's images, loaded ahead of time (sharing has to start inside the click). */
export function useImageFiles(images: DraftImage[], size: ImageSize): ImageFileForPosting[] {
  const key = images.map((i) => `${i.id}:${fileSize(i, size)}:${(size !== "none" && i.variants[size] ? i.variants[size]! : i.original).bytes}`).join("|");
  const [files, setFiles] = useState<ImageFileForPosting[]>([]);
  useEffect(() => {
    if (!images.length || size === "none") {
      setFiles([]);
      return;
    }
    let cancelled = false;
    const urls: string[] = [];
    Promise.all(
      images.map(async (image, i) => {
        const blob = await fetchImage(image.id, fileSize(image, size));
        const ext = blob.type === "image/png" ? "png" : blob.type === "image/gif" ? "gif" : blob.type === "image/webp" ? "webp" : "jpg";
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return { image, file: new File([blob], `image-${i + 1}.${ext}`, { type: blob.type }), url };
      }),
    )
      .then((out) => {
        if (!cancelled) setFiles(out);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
    // The key stands for the images (their ids, chosen files and sizes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, size]);
  return files;
}

/** Copies an image so it can be pasted into a post. Browsers copy PNG, so other types are converted. */
export function copyImage(file: Blob): Promise<void> {
  const png = (async () => {
    if (file.type === "image/png") return file;
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't copy."))), "image/png"));
  })();
  // The promise form keeps the click's permission while the PNG is made (Safari needs this).
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** Saves a file to the device. */
export function saveFile(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

type Act = (label: string, fn: () => Promise<void>) => Promise<void>;

function ImageTile({ image, index, count, size, locked, busy, act }: { image: DraftImage; index: number; count: number; size: ImageSize; locked: boolean; busy: boolean; act: Act }) {
  const shown = fileSize(image, size);
  const version = `${image.id}:${shown}:${(shown === "original" ? image.original : image.variants[shown]!).bytes}`;
  const [url, setUrl] = useState<string | null>(null);
  const [alt, setAlt] = useState(image.alt);
  useEffect(() => setAlt(image.alt), [image.alt]);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchImage(image.id, shown)
      .then((b) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // The version stands for the file shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  const shape = size === "none" ? null : size;
  const frame = shape ? SIZE_PIXELS[shape] : null;
  const cropped = Boolean(shape && image.variants[shape]);
  const fits = shape ? cropped || fitsShape(image.original, shape) : true;
  const shapeWord = shape ? SIZE_PIXELS[shape].label.split(" ")[0]!.toLowerCase() : "";
  const label = `Image ${index + 1}`;

  const crop = () =>
    act("Cropping from the original…", async () => {
      await send(`/images/${image.id}/variants/${shape}`, "PUT", await cropToSize(await fetchImage(image.id, "original"), shape!));
    });
  const uncrop = () => act("Going back to the original…", async () => void (await api(`/images/${image.id}/variants/${shape}`, { method: "DELETE" })));
  const move = (to: number) => act("Moving…", async () => void (await api(`/images/${image.id}`, { method: "PATCH", body: JSON.stringify({ position: to }) })));
  const remove = () => act("Removing…", async () => void (await api(`/images/${image.id}`, { method: "DELETE" })));
  const saveAlt = () => act("Saving…", async () => void (await api(`/images/${image.id}`, { method: "PATCH", body: JSON.stringify({ alt }) })));

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line p-2.5">
      <div className="overflow-hidden rounded-lg border border-line bg-sunken" style={{ aspectRatio: frame ? `${frame.w} / ${frame.h}` : undefined }}>
        {url ? <img src={url} alt={image.alt} className={`h-full w-full ${fits ? "object-cover" : "object-contain"}`} /> : <div className="p-6"><Loading label="Loading the image…" /></div>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <span className="rounded-md bg-raised px-2 py-0.5 font-medium text-ink-2">{label} · {SOURCE_LABELS[image.source] ?? image.source}</span>
        {image.aiGenerated && <span className="rounded-md bg-info-soft px-2 py-0.5 font-medium text-info">Labelled as AI when posted</span>}
        {cropped && <span>Cropped to {shapeWord}</span>}
        {shape && !fits && <span>Not {shapeWord} yet, shown whole</span>}
        {image.sourceUrl && <a href={image.sourceUrl} target="_blank" rel="noreferrer" className="text-accent-ink">Source ↗</a>}
      </div>
      {!locked && (
        <label className="flex flex-col gap-1">
          <span className="text-[12.5px] font-medium text-ink-2">Description (alt text)</span>
          <textarea value={alt} maxLength={1000} rows={2} onChange={(e) => setAlt(e.target.value)} placeholder="What the image shows" aria-label={`${label}: description for screen readers`} />
          {alt !== image.alt && <Button size="sm" variant="secondary" className="self-start" disabled={busy} onClick={saveAlt}>Save description</Button>}
        </label>
      )}
      {!locked && (
        <div className="flex flex-wrap gap-1.5">
          {shape && !fits && <Button size="sm" disabled={busy} onClick={crop}>Crop to {shapeWord}</Button>}
          {cropped && <Button size="sm" variant="ghost" disabled={busy} onClick={uncrop}>Use the original</Button>}
          {index > 0 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => move(index - 1)} aria-label={`Move ${label.toLowerCase()} earlier`}>← Earlier</Button>}
          {index < count - 1 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => move(index + 1)} aria-label={`Move ${label.toLowerCase()} later`}>Later →</Button>}
          <Button size="sm" variant="danger" disabled={busy} onClick={remove} aria-label={`Remove ${label.toLowerCase()}`}>Remove</Button>
        </div>
      )}
    </li>
  );
}

type ImageSet = { own: boolean; sharedWith: number; images: DraftImage[] };

export function PostImagePanel({ draft }: { draft: Draft }) {
  const { data: settings } = useApi<Settings>("/image-settings");
  const { data: personaData } = useApi<{ persona: Persona | null }>("/persona");
  const { data: set } = useApi<ImageSet>(`/drafts/${draft.id}/images`);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const locked = draft.status === "published" || draft.status === "publishing";
  const size = (settings?.sizes[draft.platform] ?? "landscape") as ImageSize;
  if (!settings || !set) return <Loading />;
  const images = set.images;
  if (size === "none" && !images.length) return <p className="m-0 text-sm text-muted">This platform posts video, so no image is added. Change this in Settings → Images.</p>;
  const room = MAX_IMAGES - images.length;

  const act: Act = async (label, fn) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      dataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  };
  const find = (source?: "link" | "screenshot" | "ai") => act("Finding an image…", async () => void (await api(`/drafts/${draft.id}/images/find`, { method: "POST", body: JSON.stringify(source ? { source } : {}) })));
  const card = () =>
    act("Making a card…", async () => {
      const text = draft.parts?.[0] ?? draft.text;
      await send(`/drafts/${draft.id}/images`, "POST", await makeCard(text, personaData?.persona?.displayName ?? "", size === "none" ? "square" : size), { source: "card", alt: cardLine(text) });
    });
  const upload = (files: File[]) =>
    act(files.length > 1 ? `Uploading ${files.length} photos…` : "Uploading…", async () => {
      for (const file of files.slice(0, room)) {
        const prepared = await prepareForPosting(file);
        if (prepared.size > MAX_UPLOAD) throw new Error(`${file.name}: images can be up to 5 MB.`);
        await send(`/drafts/${draft.id}/images`, "POST", prepared, { source: "upload", alt: "" });
      }
      if (files.length > room) throw new Error(`Only ${room} more fit: a post can have up to ${MAX_IMAGES} images.`);
    });
  const setOwn = (own: boolean) =>
    act(own ? "Copying the images for this post…" : "Going back to the shared images…", async () => void (await api(`/drafts/${draft.id}/images/own`, { method: "POST", body: JSON.stringify({ own }) })));

  return (
    <div className="flex flex-col gap-3">
      {draft.briefId && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-sunken px-3 py-2.5">
          <span className="text-[13px] text-ink-2">
            {set.own
              ? "This post has its own images. Switch off to use the shared ones again."
              : set.sharedWith > 0
                ? `Shared with the ${set.sharedWith} other post${set.sharedWith === 1 ? "" : "s"} written from the same material. A change here shows there too.`
                : "Shared by every post written from this material."}
          </span>
          {!locked && <Switch label="Use different images for this post" on={set.own} disabled={Boolean(busy)} onChange={(v) => void setOwn(v)} />}
        </div>
      )}
      {images.length ? (
        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
          {images.map((img, i) => (
            <ImageTile key={img.id} image={img} index={i} count={images.length} size={size} locked={locked} busy={Boolean(busy)} act={act} />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-muted">No images yet. Posts with an image usually get more attention. Up to {MAX_IMAGES}.</p>
      )}
      {error && <Alert>{error}</Alert>}
      {busy && <Loading label={busy} />}
      {!locked && room > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>Upload photos</Button>
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => find()}>Find an image</Button>
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={card}>Make a card</Button>
          {settings.allowAi && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => find("ai")}>AI image</Button>}
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif"
            className="sr-only"
            aria-label="Upload photos for this post"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length) void upload(files);
            }}
          />
        </div>
      )}
      {!locked && room === 0 && <p className="m-0 text-[13px] text-muted">{MAX_IMAGES} images is the most a post can have. Remove one to add another.</p>}
    </div>
  );
}

/** Settings → Images: the size each platform gets, and what Showrium may do on its own. */
export function ImageSettingsPanel({ canManage }: { canManage: boolean }) {
  const settings = useApi<Settings>("/image-settings");
  const { data: personaData } = useApi<{ persona: Persona | null }>("/persona");
  const platforms = personaData?.persona?.platforms ?? [];
  const saved = settings.data ? { ...settings.data, sizes: Object.fromEntries(platforms.map((p) => [p, settings.data!.sizes[p] ?? "landscape"])) } : null;
  const { draft, setDraft, dirty, reset } = useEditable<Settings>("image-settings", saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const LABELS: Record<string, string> = { linkedin: "LinkedIn", x: "X", instagram: "Instagram", facebook: "Facebook", threads: "Threads", bluesky: "Bluesky", mastodon: "Mastodon", tiktok: "TikTok", youtube_shorts: "YouTube Shorts" };

  if (!draft) return <Panel title="Images" id="images"><Loading /></Panel>;
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("/image-settings", { method: "PUT", body: JSON.stringify(draft) });
      settings.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title="Images" id="images">
      <p className="m-0 text-sm text-muted">Up to 4 images per post, cropped to the shape each platform shows best. The original is always kept.</p>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {platforms.map((p) => (
          <li key={p} className="flex flex-col gap-1.5">
            <span className="text-[13.5px] font-medium">{LABELS[p] ?? p}</span>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`Image size for ${LABELS[p] ?? p}`}>
              {(["landscape", "square", "portrait", "none"] as const).map((s) => (
                <Chip key={s} on={draft.sizes[p] === s} disabled={!canManage} onClick={() => setDraft((d) => (d ? { ...d, sizes: { ...d.sizes, [p]: s } } : d))}>
                  {s === "none" ? "No image" : SIZE_PIXELS[s].label}
                </Chip>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-ink-2">Find an image for new posts automatically</span>
        <Switch label="Find images automatically" on={draft.auto} disabled={!canManage} onChange={(v) => setDraft((d) => (d ? { ...d, auto: v } : d))} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-ink-2">Allow AI images when there's no real one (always labelled)</span>
        <Switch label="Allow AI images" on={draft.allowAi} disabled={!canManage} onChange={(v) => setDraft((d) => (d ? { ...d, allowAi: v } : d))} />
      </div>
      {!canManage && <p className="m-0 text-[13px] text-muted">Only owners and admins can change these.</p>}
      {(dirty || error) && <SaveBar dirty={dirty} saving={saving} error={error} savedNote="Saved." onSave={save} onDiscard={() => { reset(); setError(null); }} />}
    </Panel>
  );
}
