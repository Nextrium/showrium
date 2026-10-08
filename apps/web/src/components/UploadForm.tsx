import { useState, type FormEvent } from "react";
import { dataChanged, orgHeaders, useApi } from "../lib";
import { preparePhoto } from "../photos";
import { Alert, Button } from "../ui/kit";

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown,.md";

/** Upload a photo or a document as material to write from. Photos are kept privately for later use as the post image. */
export function UploadForm({ onUploaded, compact }: { onUploaded: (item: { id: string; title: string; kind: string }) => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const { data: allowance } = useApi<{ used: number; limit: number; creditsPerExtra: number; balance: number }>("/contexts/upload/allowance");
  const left = allowance ? Math.max(0, allowance.limit - allowance.used) : null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const picked = data.get("file");
    if (!(picked instanceof File) || !picked.size) {
      setError("Choose a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // iPhone photos (HEIC) become JPEG here; very large photos are scaled down.
      setStep("Preparing…");
      const file = picked.type.startsWith("application/") || picked.type.startsWith("text/") ? picked : await preparePhoto(picked);
      if (file.size > 10 * 1024 * 1024) throw new Error("Files can be up to 10 MB.");
      data.set("file", file, file.name);
      setStep("Reading it…");
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
      setStep(null);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line-strong bg-sunken px-4 py-6 text-center hover:border-accent">
        <span className="text-sm font-semibold text-ink">{fileName ?? "Choose a photo or document"}</span>
        <span className="text-[12.5px] font-normal text-muted">Photos (including iPhone), PDF, Word, PowerPoint or text · up to 10 MB</span>
        <input name="file" type="file" accept={ACCEPT} className="sr-only" onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)} />
      </label>
      <label>
        {compact ? "A line about it (optional for documents)" : "A line about it"}
        <textarea name="caption" rows={2} maxLength={1000} placeholder="e.g. Our team at the hackathon: we built a payments demo in 24 hours" />
      </label>
      {error && <Alert>{error}</Alert>}
      <Button disabled={busy} className="self-start">{busy ? (step ?? "Uploading…") : left === 0 && allowance ? `Upload for ${allowance.creditsPerExtra} credits` : "Upload"}</Button>
      <span className="text-[12.5px] text-muted">
        Stored privately. Photos can become your post’s image later.
        {allowance && (left! > 0 ? ` ${left} of ${allowance.limit} uploads left today.` : ` You’ve used today’s ${allowance.limit} uploads; extra ones cost ${allowance.creditsPerExtra} credits each (you have ${allowance.balance}).`)}
      </span>
    </form>
  );
}
