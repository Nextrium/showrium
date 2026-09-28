import { useState, type FormEvent } from "react";
import { dataChanged, orgHeaders } from "../lib";
import { Alert, Button } from "../ui/kit";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown,.md";

/** Upload a photo or a document as material to write from. Photos are kept privately for later use as the post image. */
export function UploadForm({ onUploaded, compact }: { onUploaded: (item: { id: string; title: string; kind: string }) => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || !file.size) {
      setError("Choose a file first.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Files can be up to 10 MB.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Multipart upload: the browser sets the boundary, so no Content-Type header here.
      const res = await fetch("/api/v1/contexts/upload", { method: "POST", headers: orgHeaders(), body: data });
      const body = (await res.json().catch(() => null)) as { id: string; title: string; kind: string; error?: { message: string } } | null;
      if (!res.ok || !body) throw new Error(body?.error?.message ?? `Upload failed (${res.status}).`);
      form.reset();
      setFileName(null);
      dataChanged();
      onUploaded(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line-strong bg-sunken px-4 py-6 text-center hover:border-accent">
        <span className="text-sm font-semibold text-ink">{fileName ?? "Choose a photo or document"}</span>
        <span className="text-[12.5px] font-normal text-muted">JPG, PNG, WebP, PDF, Word, PowerPoint or text · up to 10 MB</span>
        <input name="file" type="file" accept={ACCEPT} className="sr-only" onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)} />
      </label>
      <label>
        {compact ? "A line about it (optional for documents)" : "A line about it"}
        <textarea name="caption" rows={2} maxLength={1000} placeholder="e.g. Our team at the hackathon: we built a payments demo in 24 hours" />
      </label>
      {error && <Alert>{error}</Alert>}
      <Button disabled={busy} className="self-start">{busy ? "Reading it…" : "Upload"}</Button>
      <span className="text-[12.5px] text-muted">Stored privately. Photos can become your post’s image later.</span>
    </form>
  );
}
