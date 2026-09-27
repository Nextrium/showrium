import { useState, type FormEvent } from "react";
import { Link } from "../../App";
import { api, formatDate, useApi } from "../../lib";

type Source = { id: string; kind: string; key: string; lastCheckedAt: string | null; lastError: string | null };
type ContextItem = { id: string; kind: string; title: string; body: string; url: string | null; createdAt: string };

export function SourcesPage() {
  const sources = useApi<{ data: Source[] }>("/sources");
  const contexts = useApi<{ data: ContextItem[] }>("/contexts");
  const [kind, setKind] = useState<"github_repo" | "rss">("github_repo");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get("value")).trim();
    setError(null);
    try {
      await api("/sources", { method: "POST", body: JSON.stringify(kind === "github_repo" ? { kind, repo: value } : { kind, url: value }) });
      sources.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the source.");
    }
  };
  const sync = async (id: string) => {
    setError(null);
    setMessage("Checking for new items…");
    try {
      const out = await api<{ added: number; error: string | null }>(`/sources/${id}/sync`, { method: "POST" });
      setMessage(out.error ? null : `${out.added} new item${out.added === 1 ? "" : "s"}.`);
      if (out.error) setError(out.error);
      sources.reload();
      contexts.reload();
    } catch (err) {
      setMessage(null);
      setError(err instanceof Error ? err.message : "Sync failed.");
    }
  };
  const remove = async (id: string) => {
    await api(`/sources/${id}`, { method: "DELETE" }).catch(() => undefined);
    sources.reload();
  };

  return (
    <div className="dash">
      <section className="card">
        <h3>Connected sources</h3>
        <p className="note">Showrium checks these for new releases and posts you can share.</p>
        <form className="row" onSubmit={add}>
          <label>
            Type
            <select id="src-kind" value={kind} onChange={(e) => setKind(e.target.value as "github_repo" | "rss")}>
              <option value="github_repo">GitHub repository</option>
              <option value="rss">Blog or RSS feed</option>
            </select>
          </label>
          <label>
            {kind === "github_repo" ? "owner/repository" : "Feed URL"}
            <input id="src-value" name="value" required placeholder={kind === "github_repo" ? "nextrium/showrium" : "https://example.com/feed.xml"} />
          </label>
          <button className="button">Add</button>
        </form>
        {message && <p className="note" role="status">{message}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="table-wrap">
          <table>
            <tbody>
              {sources.data?.data.map((s) => (
                <tr key={s.id}>
                  <td>{s.kind === "github_repo" ? "GitHub" : "Feed"}</td>
                  <td>{s.key}</td>
                  <td className="muted">{s.lastError ? `Error: ${s.lastError}` : s.lastCheckedAt ? `Checked ${formatDate(s.lastCheckedAt)}` : "Not checked yet"}</td>
                  <td className="num">
                    <button className="button secondary" onClick={() => sync(s.id)}>Check now</button>{" "}
                    <button className="button danger" onClick={() => remove(s.id)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h3>Material you can post about</h3>
        {contexts.data?.data.length === 0 && <p className="note">Nothing yet. Add a source, a link, notes or a voice note.</p>}
        <ul className="items">
          {contexts.data?.data.map((c) => (
            <li key={c.id}>
              <strong>{c.title || c.body.slice(0, 80)}</strong> <span className="muted">· {c.kind.replace("_", " ")} · {formatDate(c.createdAt)}</span>{" "}
              <Link to={`/app?context=${c.id}`}>Create posts</Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
