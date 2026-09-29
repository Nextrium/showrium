import { useState, type FormEvent } from "react";
import { api, formatDate, useApi } from "../../lib";
import type { Draft } from "./shared";
import { PageHeader } from "../../ui/kit";

type Idea = { id: string; reason: string; score: number; title: string; body: string; url: string | null; createdAt: string };
type Theme = { label: string; kind: string; count: number; examples: string[]; suggestion: string };
type Insight = { id: string; themes: Theme[]; basedOn: number; createdAt: string } | null;
type Analytics = {
  statuses: Record<string, number>;
  platforms: { platform: string; posts: number; likes: number; replies: number; reposts: number }[];
  modes: { mode: string; posts: number; avgScore: number }[];
  perWeek: number[];
  top: { id: string; platform: string; text: string; url: string | null; score: number }[];
  aiCostUsdThisMonth: number;
  newIdeas: number;
};

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

function Stats() {
  const { data } = useApi<Analytics>("/analytics");
  if (!data) return null;
  const max = Math.max(1, ...data.perWeek);
  return (
    <section className="card">
      <h3>How it's going</h3>
      <div className="row stats">
        <div><strong>{data.statuses.published ?? 0}</strong><span className="note">published</span></div>
        <div><strong>{(data.statuses.draft ?? 0) + (data.statuses.approved ?? 0)}</strong><span className="note">waiting</span></div>
        <div><strong>{data.statuses.scheduled ?? 0}</strong><span className="note">scheduled</span></div>
        <div><strong>{data.newIdeas}</strong><span className="note">new ideas</span></div>
      </div>
      <p className="note">Posts published per week (last 8 weeks)</p>
      <div className="bars" role="img" aria-label={`Posts per week: ${data.perWeek.join(", ")}`}>
        {data.perWeek.map((v, i) => <span key={i} style={{ height: `${Math.max(4, (v / max) * 100)}%` }} title={`${v}`} />)}
      </div>
      {data.platforms.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Last 30 days</th><th>Posts</th><th>Likes</th><th>Replies</th><th>Reposts</th></tr></thead>
          <tbody>{data.platforms.map((p) => <tr key={p.platform}><td>{p.platform}</td><td>{p.posts}</td><td>{p.likes}</td><td>{p.replies}</td><td>{p.reposts}</td></tr>)}</tbody>
        </table></div>
      )}
      {data.top.length > 0 && (
        <>
          <p className="note">Best posts</p>
          <ul className="items">{data.top.map((t) => <li key={t.id}>{t.url ? <a href={t.url} target="_blank" rel="noreferrer">{t.text}</a> : t.text} <span className="muted">· {t.platform} · score {t.score}</span></li>)}</ul>
        </>
      )}
      <p className="note">Counts come from Bluesky and Mastodon automatically, and from the numbers you enter for other platforms.</p>
    </section>
  );
}

function Audience({ onIdea }: { onIdea: () => void }) {
  const { data, reload } = useApi<{ insight: Insight }>("/insights");
  const published = useApi<{ data: Draft[] }>("/drafts?status=published");
  const comments = useApi<{ data: { id: string; platform: string; author: string; text: string; origin: string }[] }>("/engagement");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await fn());
    } catch (err) {
      setError(errorText(err, "That didn't work."));
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => run(async () => (await api("/insights/refresh", { method: "POST" }), reload(), "Updated."));
  const makeIdea = (i: number) => run(async () => (await api(`/insights/${data!.insight!.id}/themes/${i}/idea`, { method: "POST" }), onIdea(), "Added to Ideas."));
  const paste = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const num = (k: string) => (f.get(k) ? Number(f.get(k)) : undefined);
    return run(async () => {
      const lines = String(f.get("comments") ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
      await api(`/drafts/${String(f.get("draftId"))}/engagement`, { method: "POST", body: JSON.stringify({ comments: lines, likes: num("likes"), replies: num("replies"), reposts: num("reposts") }) });
      form.reset();
      comments.reload();
      return "Saved.";
    });
  };
  const insight = data?.insight;

  return (
    <section className="card">
      <h3>What your audience is saying</h3>
      <div className="row">
        <button className="button secondary" disabled={busy} onClick={refresh}>{busy ? "Working…" : "Find themes in comments"}</button>
        {insight && <span className="note">From {insight.basedOn} comments · {formatDate(insight.createdAt)}</span>}
      </div>
      {insight?.themes.length === 0 && <p className="note">No clear themes yet.</p>}
      <ul className="items">
        {insight?.themes.map((t, i) => (
          <li key={i}>
            <strong>{t.label}</strong> <span className="chip">{t.kind}</span> <span className="muted">· {t.count}</span>
            {t.examples.length > 0 && <p className="note">"{t.examples.join('" · "')}"</p>}
            <p>{t.suggestion}</p>
            <button className="button secondary" disabled={busy} onClick={() => makeIdea(i)}>Make this an idea</button>
          </li>
        ))}
      </ul>

      <details>
        <summary>Add comments from LinkedIn, X, TikTok or elsewhere</summary>
        <p className="note">These platforms don't let apps read comments, so paste them here (one per line). Only you see them; they're used to find themes.</p>
        <form className="form" onSubmit={paste}>
          <label>Post<select name="draftId" required>{published.data?.data.map((d) => <option key={d.id} value={d.id}>{d.platform}: {d.text.slice(0, 60)}</option>)}</select></label>
          <label>Comments<textarea name="comments" rows={4} maxLength={50_000} /></label>
          <div className="row">
            <label>Likes<input name="likes" type="number" min={0} /></label>
            <label>Replies<input name="replies" type="number" min={0} /></label>
            <label>Reposts<input name="reposts" type="number" min={0} /></label>
          </div>
          <button className="button" disabled={busy || !published.data?.data.length}>Save</button>
        </form>
      </details>

      {comments.data && comments.data.data.length > 0 && (
        <details>
          <summary>Recent comments ({comments.data.data.length})</summary>
          <ul className="items">{comments.data.data.slice(0, 30).map((c) => <li key={c.id}><span className="muted">{c.platform} {c.author}</span> {c.text}</li>)}</ul>
        </details>
      )}
      {message && <p className="note" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

export function InsightsPage() {
  return (
    <div className="dash">
      <PageHeader title="Insights" subtitle="How your posts are doing, and what your audience is saying." />
      <Stats />
      <Audience onIdea={() => undefined} />
    </div>
  );
}
