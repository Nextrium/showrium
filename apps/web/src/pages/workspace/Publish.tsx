import { useState } from "react";
import { copyImage, saveFile, useImageFiles, type ImageSize } from "../../components/PostImage";
import { api, ApiError, useApi } from "../../lib";
import { Info } from "../../ui/kit";
import type { Draft } from "./shared";

type Connection = { id: string; platform: string; handle: string; status: string };
const API_PLATFORMS = ["x", "linkedin", "bluesky", "mastodon"];
const OPEN_APP: Record<string, string> = {
  facebook: "https://www.facebook.com/",
  instagram: "https://www.instagram.com/",
  tiktok: "https://www.tiktok.com/upload",
  youtube_shorts: "https://studio.youtube.com/",
};

export function PublishControls({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const { data } = useApi<{ data: Connection[] }>("/connections");
  // Loaded ahead of time so "Post it myself" is a plain link: opening a tab after an await
  // is treated as an unrequested popup and blocked by browsers.
  const { data: intent } = useApi<{ url: string | null }>(`/drafts/${draft.id}/intent`, { live: false });
  const postUrl = intent ? intent.url ?? OPEN_APP[draft.platform] ?? null : null;
  const accounts = (data?.data ?? []).filter((c) => c.platform === draft.platform && c.status === "active");
  const [connectionId, setConnectionId] = useState<string>("");
  const [when, setWhen] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where you are in "Post it myself", kept for this tab: on phones, coming back from the X app can reload the page.
  const stepKey = `showrium:tap:${draft.id}`;
  const saved = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(stepKey) ?? "null") as { opened?: boolean; rootUrl?: string } | null;
    } catch {
      return null;
    }
  })();
  const [opened, setOpenedState] = useState(Boolean(saved?.opened));
  const [rootUrl, setRootUrlState] = useState(saved?.rootUrl ?? "");
  const remember = (next: { opened: boolean; rootUrl: string }) => {
    try {
      sessionStorage.setItem(stepKey, JSON.stringify(next));
    } catch {
      // Private mode: the step simply isn't remembered.
    }
  };
  const setOpened = (v: boolean) => {
    setOpenedState(v);
    remember({ opened: v, rootUrl });
  };
  const setRootUrl = (v: string) => {
    setRootUrlState(v);
    remember({ opened, rootUrl: v });
  };
  // The id of your post on X, from its link (x.com/<you>/status/<id>), so replies open already replying to it.
  const rootId = rootUrl.match(/^https:\/\/(?:x|twitter)\.com\/[^/]+\/status\/(\d{5,25})/i)?.[1] ?? null;
  const replyUrl = (text: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&in_reply_to=${rootId}`;
  // A link (a quoted post is a link too) or a mention: always "Post it myself" on X.
  const xLink = draft.platform === "x" && (/https?:\/\//i.test(draft.text) || /(^|[^\w@.])@[A-Za-z0-9_]{1,15}(?![\w@])/.test(draft.text));
  const chosen = connectionId || accounts[0]?.id || "";
  // The post's images, loaded now: the share sheet only opens straight from a click.
  const { data: imageSettings } = useApi<{ sizes: Partial<Record<string, ImageSize>> }>("/image-settings", { live: false });
  const files = useImageFiles(draft.images ?? [], imageSettings ? (imageSettings.sizes[draft.platform] ?? "landscape") : "none");
  const [copiedImage, setCopiedImage] = useState<number | null>(null);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const publishNow = () =>
    act(async () => {
      const out = await api<{ url: string | null }>(`/drafts/${draft.id}/publish`, { method: "POST", body: JSON.stringify({ connectionId: chosen }) });
      onChange({ ...draft, status: "published", externalUrl: out.url });
    });
  // Another post on the account near this time: the person chooses (move the automated one, or keep both).
  const [clash, setClash] = useState<{ message: string; auto: boolean } | null>(null);
  const schedule = (onClash?: "move" | "keep") =>
    act(async () => {
      try {
        const out = await api<{ moved: { id: string; at: string | null }[] }>(`/drafts/${draft.id}/schedule`, { method: "POST", body: JSON.stringify({ connectionId: chosen, at: new Date(when).toISOString(), ...(onClash ? { onClash } : {}) }) });
        setClash(null);
        const moved = out.moved.map((m) => (m.at ? `moved the automated post to ${new Date(m.at).toLocaleString()}` : "the automated post had no free time left, so it's back in Approved")).join("; ");
        setMessage(`Scheduled for ${new Date(when).toLocaleString()}.${moved ? ` Also ${moved}.` : ""}`);
        onChange({ ...draft, status: "scheduled", scheduledAt: new Date(when).toISOString(), autoScheduled: false });
      } catch (err) {
        if (err instanceof ApiError && (err.code === "schedule_clash" || err.code === "schedule_clash_auto")) {
          setClash({ message: err.message, auto: err.code === "schedule_clash_auto" });
          return;
        }
        throw err;
      }
    });
  const parts = draft.parts && draft.parts.length > 1 ? draft.parts : null;
  const [copiedPart, setCopiedPart] = useState<number | null>(null);
  const [copiedComment, setCopiedComment] = useState(false);
  const tapToPost = () => {
    // Runs synchronously inside the click, alongside the link opening in a new tab.
    navigator.clipboard.writeText(parts ? parts[0]! : draft.text).catch(() => undefined);
    setOpened(true);
    setMessage(
      parts
        ? "The first part is ready to post. Then reply to it with each part below, in order."
        : intent?.url
          ? "Opened with your post filled in. Post it there, then mark it as posted."
          : "Your post is copied. Paste it in the app, then mark it as posted.",
    );
  };
  const firstText = parts ? parts[0]! : draft.text;
  // Phones (and some computers) can hand the text and the images to the platform's app in one go.
  const shareData = files.length ? { text: firstText, files: files.map((f) => f.file) } : null;
  const canShareFiles = Boolean(shareData && typeof navigator.canShare === "function" && navigator.canShare(shareData));
  const shareWithImages = () => {
    // Text copied too: some apps take only the images from a share.
    navigator.clipboard.writeText(firstText).catch(() => undefined);
    navigator
      .share(shareData!)
      .then(() => {
        setOpened(true);
        setMessage("Shared. Finish the post in the app (the text is also copied, in case it didn't come through), then mark it as posted.");
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError("Couldn't open sharing. Use the buttons below instead.");
      });
  };
  const copyOneImage = (i: number) =>
    copyImage(files[i]!.file)
      .then(() => setCopiedImage(i))
      .catch(() => setError("This browser can't copy images. Save it instead, then attach it."));
  const saveAll = () => files.forEach((f) => saveFile(f.url, f.file.name));
  const copyPart = (i: number) => {
    navigator.clipboard.writeText(parts![i]!).then(() => setCopiedPart(i)).catch(() => setError("Couldn't copy. Select the text and copy it yourself."));
  };
  const markPosted = () =>
    act(async () => {
      const url = rootId ? rootUrl.split("?")[0]! : null;
      await api(`/drafts/${draft.id}/mark-published`, { method: "POST", body: JSON.stringify({ url }) });
      try {
        sessionStorage.removeItem(stepKey);
      } catch {
        // Nothing to clear.
      }
      onChange({ ...draft, status: "published", externalUrl: url });
    });

  // X posts with a link never go through the app (X charges much more for links): "Post it myself" only.
  const canApi = API_PLATFORMS.includes(draft.platform) && accounts.length > 0 && !xLink;
  return (
    <div className="form">
      <div className="row">
        {canShareFiles && <button className="button" onClick={shareWithImages}>Share with {files.length === 1 ? "image" : `${files.length} images`} (free)</button>}
        {postUrl ? (
          <a className={canShareFiles ? "button secondary" : "button"} href={postUrl} target="_blank" rel="noopener noreferrer" onClick={tapToPost}>Post it myself (free)</a>
        ) : (
          <button className={canShareFiles ? "button secondary" : "button"} onClick={tapToPost}>Copy for posting (free)</button>
        )}
        {opened && <button className="button secondary" disabled={busy} onClick={markPosted}>I've posted it</button>}
      </div>
      {files.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
          <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
            {files.length === 1 ? "The image" : `The ${files.length} images`} for this post{parts ? " (first part)" : ""}
            <Info label="About the images">Copy and paste {files.length === 1 ? "it" : "each one"} into the post, or save and attach {files.length === 1 ? "it" : "them"}.</Info>
          </span>
          <ul className="m-0 flex list-none flex-wrap gap-2.5 p-0" aria-label="Images to add to the post">
            {files.map((f, i) => (
              <li key={f.image.id} className="flex w-[148px] flex-col gap-1.5">
                <img src={f.url} alt={f.image.alt} className="h-[96px] w-full rounded-lg border border-line object-cover" />
                <div className="flex gap-1.5">
                  {typeof ClipboardItem !== "undefined" && (
                    <button type="button" className="button secondary" onClick={() => void copyOneImage(i)} aria-label={`Copy image ${i + 1}`}>{copiedImage === i ? "Copied" : "Copy"}</button>
                  )}
                  <button type="button" className="button secondary" onClick={() => saveFile(f.url, f.file.name)} aria-label={`Save image ${i + 1}`}>Save</button>
                </div>
              </li>
            ))}
          </ul>
          {files.length > 1 && <button type="button" className="button secondary self-start" onClick={saveAll}>Save all {files.length}</button>}
        </div>
      )}
      {draft.linkComment && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
            <strong className="shrink-0 font-semibold">First comment:</strong>
            <span className="truncate">{draft.linkComment}</span>
            <Info label="About the first comment">The source link goes in the first comment, because a link in a LinkedIn post hides its image. Through the app it's added for you; when you post it yourself, add it as a comment.</Info>
          </span>
          <button type="button" className="button secondary" onClick={() => void navigator.clipboard?.writeText(draft.linkComment!).then(() => setCopiedComment(true))}>{copiedComment ? "Copied" : "Copy link"}</button>
        </div>
      )}
      {xLink && API_PLATFORMS.includes(draft.platform) && accounts.length > 0 && (
        <p className="note">Has a link, quote or mention, so it goes to X with "Post it myself" (free). <Info label="Why these go this way">X charges a lot more for links sent through the app, and limits automated mentions. Posting it yourself is free.</Info></p>
      )}
      {opened && parts && draft.platform === "x" && (
        <label className="flex flex-col gap-1" htmlFor={`x-root-${draft.id}`}>
          <span className="flex items-center gap-1.5">Link to your post on X <Info label="About the post link">Paste it from X (Share, then Copy link). Each reply below then opens X already replying to your post.</Info></span>
          <input id={`x-root-${draft.id}`} type="url" inputMode="url" value={rootUrl} onChange={(e) => setRootUrl(e.target.value.trim())} placeholder="https://x.com/you/status/…" />
          {rootId && <span className="text-[12.5px] text-muted">Replies now open already replying to your post.</span>}
        </label>
      )}
      {opened && parts && (
        <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Thread parts to post as replies">
          {parts.slice(1).map((part, n) => (
            <li key={n} className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[13.5px]"><strong className="font-semibold">Reply {n + 1}:</strong> {part}</span>
              {draft.platform === "x" && rootId ? (
                <a className="button" href={replyUrl(part)} target="_blank" rel="noopener noreferrer">Post reply</a>
              ) : null}
              <button type="button" className="button secondary" onClick={() => copyPart(n + 1)}>{copiedPart === n + 1 ? "Copied" : "Copy"}</button>
            </li>
          ))}
        </ol>
      )}
      {canApi && (
        <div className="row">
          {accounts.length > 1 && (
            <label>
              Account
              <select value={chosen} onChange={(e) => setConnectionId(e.target.value)}>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.handle}</option>)}
              </select>
            </label>
          )}
          <button className="button secondary" disabled={busy} onClick={publishNow}>
            Publish {parts ? `thread (${parts.length} parts)` : "now"}{draft.platform === "x" ? " (uses X credits)" : ""}
          </button>
          <label>
            Or schedule
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
          <button className="button secondary" disabled={busy || !when} onClick={() => schedule()}>Schedule</button>
        </div>
      )}
      {clash && (
        <div className="flex flex-col gap-2 rounded-xl border border-warn bg-warn-soft p-3" role="alert">
          <span className="text-[13.5px] text-ink">{clash.message}</span>
          <div className="flex flex-wrap gap-2">
            {clash.auto && <button className="button" disabled={busy} onClick={() => schedule("move")}>Move the automated post</button>}
            <button className="button secondary" disabled={busy} onClick={() => schedule("keep")}>Keep both</button>
            <button className="button secondary" disabled={busy} onClick={() => setClash(null)}>Pick another time</button>
          </div>
        </div>
      )}
      {message && <p className="note" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
