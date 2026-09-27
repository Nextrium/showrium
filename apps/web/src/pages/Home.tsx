import { Link } from "../App";
import { APP_ORIGIN } from "../lib";

const PLATFORMS = ["LinkedIn", "X", "Instagram", "Facebook", "Threads", "TikTok", "YouTube Shorts", "Bluesky", "Mastodon", "Dev.to"];

export function Home() {
  return (
    <>
      <section className="hero">
        <span className="eyebrow">Private beta</span>
        <h1>Show what you can do.</h1>
        <p className="lede">
          Showrium turns the work you've already done, the ideas in your head and the things that make you laugh into
          posts made for each platform, written in your own voice. You approve every post.
        </p>
        <div className="actions">
          <Link to={`${APP_ORIGIN}/signin`} className="button">
            Get started free
          </Link>
          <a href={`${APP_ORIGIN}/api/docs`} className="button secondary">
            API docs for developers
          </a>
        </div>
        <div className="platforms" aria-label="Supported platforms">
          {PLATFORMS.map((p) => (
            <span className="chip" key={p}>
              {p}
            </span>
          ))}
        </div>
      </section>

      <section className="features" aria-label="What Showrium does">
        <div className="card">
          <h3>Starts from your real work</h3>
          <p>Connect a repo, a blog or just record a voice note. A merged release can become a post before you've closed the tab.</p>
        </div>
        <div className="card">
          <h3>Each platform in its own format</h3>
          <p>A LinkedIn story, a short X post, an Instagram caption and a video script, from one idea. Only on the accounts you choose.</p>
        </div>
        <div className="card">
          <h3>Video without a camera</h3>
          <p>Explainers with voice-over, animated code and captions, made for you. AI content is always labelled.</p>
        </div>
        <div className="card">
          <h3>You stay in control</h3>
          <p>Drafts wait for your approval. Showrium never replies, follows or messages anyone for you.</p>
        </div>
      </section>
    </>
  );
}
