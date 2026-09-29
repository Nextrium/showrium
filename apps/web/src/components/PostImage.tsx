// Sprint 6: the post's one image. Cards and crops to the preferred size are made here, in the
// browser (free, like the video renderer), and uploaded. Finding one (the person's photo, the
// link's preview image, a screenshot, AI) happens on the server.
import { useEffect, useRef, useState } from "react";
import { api, dataChanged, orgHeaders, useApi, useEditable } from "../lib";
import { preparePhoto } from "../photos";
import { Alert, Button, Chip, Loading, Panel, SaveBar, Switch } from "../ui/kit";
import type { Draft, Persona, Platform } from "../pages/workspace/shared";

export type ImageSize = "square" | "portrait" | "landscape" | "none";
type Settings = { sizes: Partial<Record<Platform, ImageSize>>; auto: boolean; allowAi: boolean };

export const SIZE_PIXELS: Record<Exclude<ImageSize, "none">, { w: number; h: number; label: string }> = {
  square: { w: 1080, h: 1080, label: "Square (1:1)" },
  portrait: { w: 1080, h: 1350, label: "Portrait (4:5)" },
  landscape: { w: 1200, h: 675, label: "Landscape (16:9)" },
};
const SOURCE_LABELS: Record<string, string> = {
  upload: "Your photo",
  link: "From the link",
  screenshot: "Screenshot of the page",
  card: "Designed card",
  ai: "AI-generated",
};

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the image."))), "image/jpeg", 0.86));
}

/** Crops an image to the size, filling the frame (like "cover"), centred. */
export async function cropToSize(src: Blob, size: Exclude<ImageSize, "none">): Promise<Blob> {
  const { w, h } = SIZE_PIXELS[size];
  const bitmap = await createImageBitmap(src);
  const scale = Math.max(w / bitmap.width, h / bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, (w - bitmap.width * scale) / 2, (h - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
  return canvasBlob(canvas);
}

/** The first sentence or line of the post, for a card. */
export function cardLine(text: string): string {
  const first = text.replace(/https?:\/\/\S+/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const sentence = first.match(/^.{20,220}?[.!?](\s|$)/)?.[0] ?? first;
  return sentence.trim().slice(0, 220);
}

/** A designed card: the post's key line on a calm background, with the author's name. No Showrium branding. */
export async function makeCard(text: string, author: string, size: Exclude<ImageSize, "none">): Promise<Blob> {
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

async function uploadImage(draftId: string, blob: Blob, source: "upload" | "card" | "crop", alt?: string) {
  const form = new FormData();
  form.set("file", blob, "image.jpg");
  form.set("source", source);
  if (alt !== undefined) form.set("alt", alt);
  const res = await fetch(`/api/v1/drafts/${draftId}/image`, { method: "PUT", headers: orgHeaders(), body: form });
  const out = (await res.json().catch(() => null)) as { error?: { message: string } } | null;
  if (!res.ok) throw new Error(out?.error?.message ?? `Couldn't save the image (${res.status}).`);
  dataChanged();
}

/** The image file for display: fetched with the workspace header (an <img> tag can't send it). */
function useImageUrl(draftId: string, version: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    if (!version) {
      setUrl(null);
      setBlob(null);
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    fetch(`/api/v1/drafts/${draftId}/image`, { headers: orgHeaders() })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!b || revoked) return;
        objectUrl = URL.createObjectURL(b);
        setBlob(b);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [draftId, version]);
  return { url, blob };
}

export function PostImagePanel({ draft }: { draft: Draft }) {
  const { data: settings } = useApi<Settings>("/image-settings");
  const { data: personaData } = useApi<{ persona: Persona | null }>("/persona");
  const image = draft.image ?? null;
  const version = image ? `${image.bytes}-${image.source}-${image.width ?? 0}x${image.height ?? 0}` : null;
  const { url, blob } = useImageUrl(draft.id, version);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alt, setAlt] = useState(image?.alt ?? "");
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => setAlt(image?.alt ?? ""), [image?.alt]);

  const locked = draft.status === "published" || draft.status === "publishing";
  const size = (settings?.sizes[draft.platform] ?? "landscape") as ImageSize;
  if (!settings) return <Loading />;
  if (size === "none" && !image) return <p className="m-0 text-sm text-muted">This platform posts video, so no image is added. Change this in Settings → Images.</p>;
  const frame = size === "none" ? null : SIZE_PIXELS[size];
  const fits = image && frame && image.width && image.height ? Math.abs(image.width / image.height - frame.w / frame.h) < 0.02 : false;

  const act = async (label: string, fn: () => Promise<void>) => {
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
  const find = (source?: "link" | "screenshot" | "ai" | "upload") => act("Finding an image…", async () => void (await api(`/drafts/${draft.id}/image/find`, { method: "POST", body: JSON.stringify(source ? { source } : {}) })));
  const card = () =>
    act("Making a card…", async () => {
      const text = cardLine(draft.parts?.[0] ?? draft.text);
      await uploadImage(draft.id, await makeCard(draft.parts?.[0] ?? draft.text, personaData?.persona?.displayName ?? "", size === "none" ? "square" : size), "card", text);
    });
  const crop = () => act("Cropping…", async () => void (blob && frame && (await uploadImage(draft.id, await cropToSize(blob, size as Exclude<ImageSize, "none">), "crop"))));
  const upload = (file: File) =>
    act("Uploading…", async () => {
      const prepared = await preparePhoto(file);
      if (prepared.size > 5 * 1024 * 1024) throw new Error("Images can be up to 5 MB.");
      await uploadImage(draft.id, prepared, "upload", "");
    });
  const remove = () => act("Removing…", async () => void (await api(`/drafts/${draft.id}/image`, { method: "DELETE" })));
  const saveAlt = () => act("Saving…", async () => void (await api(`/drafts/${draft.id}/image`, { method: "PATCH", body: JSON.stringify({ alt }) })));
  const download = () =>
    act("Preparing…", async () => {
      // A short-lived link, so the file opens or downloads even outside the app (e.g. on a phone).
      const { url: link } = await api<{ url: string }>(`/drafts/${draft.id}/image/link`, { method: "POST" });
      window.open(`${link}&download=1`, "_blank", "noopener");
    });

  return (
    <div className="flex flex-col gap-3">
      {image ? (
        <>
          <div className="overflow-hidden rounded-xl border border-line bg-sunken" style={{ aspectRatio: frame ? `${frame.w} / ${frame.h}` : undefined }}>
            {url ? <img src={url} alt={image.alt} className="h-full w-full object-cover" /> : <div className="p-6"><Loading label="Loading the image…" /></div>}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
            <span className="rounded-md bg-raised px-2 py-0.5 font-medium text-ink-2">{SOURCE_LABELS[image.source] ?? image.source}</span>
            {image.aiGenerated && <span className="rounded-md bg-info-soft px-2 py-0.5 font-medium text-info">Labelled as AI when posted</span>}
            {frame && <span>{fits ? `${SIZE_PIXELS[size as Exclude<ImageSize, "none">].label}` : `Shown cropped to ${SIZE_PIXELS[size as Exclude<ImageSize, "none">].label.toLowerCase()}`}</span>}
            {image.sourceUrl && <a href={image.sourceUrl} target="_blank" rel="noreferrer" className="text-accent-ink">Source ↗</a>}
          </div>
          {!locked && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-ink-2">Description for screen readers (alt text)</span>
              <textarea value={alt} maxLength={1000} rows={2} onChange={(e) => setAlt(e.target.value)} placeholder="What the image shows" />
              {alt !== image.alt && <Button size="sm" variant="secondary" className="self-start" disabled={Boolean(busy)} onClick={saveAlt}>Save description</Button>}
            </label>
          )}
        </>
      ) : (
        <p className="m-0 text-sm text-muted">No image yet. Posts with an image usually get more attention.</p>
      )}
      {error && <Alert>{error}</Alert>}
      {busy && <Loading label={busy} />}
      {!locked && (
        <div className="flex flex-wrap gap-2">
          {image && frame && !fits && url && <Button size="sm" disabled={Boolean(busy)} onClick={crop}>Crop to {SIZE_PIXELS[size as Exclude<ImageSize, "none">].label.split(" ")[0]!.toLowerCase()}</Button>}
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => find()}>{image ? "Find another" : "Find an image"}</Button>
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={card}>Make a card</Button>
          <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => fileRef.current?.click()}>Upload a photo</Button>
          {settings.allowAi && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => find("ai")}>AI image</Button>}
          {image && <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={download}>Download</Button>}
          {image && <Button size="sm" variant="danger" disabled={Boolean(busy)} onClick={remove}>Remove</Button>}
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif" className="sr-only" aria-label="Upload a photo for this post" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
        </div>
      )}
      {locked && image && <Button size="sm" variant="ghost" className="self-start" disabled={Boolean(busy)} onClick={download}>Download</Button>}
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
      <p className="m-0 text-sm text-muted">One image per post, in the shape each platform shows best.</p>
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
