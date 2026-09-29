// The public website (showrium.com): what Showrium is, and the waitlist. It has no way into the
// app on purpose: testers get invite links, and the app lives at app.showrium.com.
import type { ReactNode } from "react";
import { WaitlistForm } from "../components/WaitlistForm";
import { Icon, type IconName } from "../ui/kit";

const PLATFORMS = ["LinkedIn", "X", "Instagram", "Facebook", "Threads", "TikTok", "YouTube Shorts", "Bluesky", "Mastodon"];

const SOURCES: { icon: IconName; title: string; body: string }[] = [
  { icon: "git", title: "Your code", body: "Releases and each day's commits on a public GitHub repository." },
  { icon: "sources", title: "Your writing and videos", body: "A blog, a YouTube channel or a podcast. New pieces become posts that point back to them." },
  { icon: "photo", title: "Your day", body: "A photo of your work, a whiteboard, a PDF, a voice note, or one sentence answering today's question." },
];

const STEPS: { title: string; body: string }[] = [
  { title: "Share what you did", body: "Connect a source once, or drop in a photo, a link or a thought. Showrium spots what's worth posting." },
  { title: "Get a post for each platform", body: "A LinkedIn story, a short X post, a caption, a video script. Each in the platform's own format, in your voice." },
  { title: "Approve, then post", body: "Edit anything, approve with one tap, and post now or on a schedule. Nothing goes out without you." },
];

const PEOPLE = ["Developers", "Founders", "Designers", "Creators and writers", "Teachers and students", "Marketers", "Small businesses", "Health and care workers"];

const PROMISES: { icon: IconName; title: string; body: string }[] = [
  { icon: "check", title: "You approve every post", body: "Drafts wait for you. Autopilot is something you switch on, per platform." },
  { icon: "comment", title: "It never talks for you", body: "No automatic replies, follows, likes or messages. Ever." },
  { icon: "lock", title: "Only where you already are", body: "Posts go only to the accounts you choose, through each platform's official tools." },
  { icon: "alert", title: "Honest by default", body: "No invented numbers or claims, no hashtag spam, and AI images and video are labelled." },
];

function Section({ eyebrow, title, children, id }: { eyebrow: string; title: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="flex flex-col gap-6 border-t border-line py-14 sm:py-20">
      <div className="flex max-w-2xl flex-col gap-2">
        <span className="eyebrow">{eyebrow}</span>
        <h2 className="text-[28px] font-semibold leading-tight sm:text-[36px]">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function Home() {
  return (
    <>
      <section className="flex flex-col gap-6 pb-14 pt-10 sm:pb-20 sm:pt-16">
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-accent/40 bg-accent-soft px-3 py-1 font-mono text-[12px] uppercase tracking-[0.12em] text-accent-ink">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
          Launching soon
        </span>
        <h1 className="max-w-[16ch] text-[40px] font-semibold leading-[1.02] sm:text-[64px]">Show what you can do.</h1>
        <p className="lede">
          You do good work every day and almost nobody sees it. Showrium turns what you've already done, and what's on your mind, into posts
          for every platform you use, written in your own voice. You approve every one.
        </p>
        <div id="waitlist" className="flex max-w-xl scroll-mt-24 flex-col gap-2">
          <WaitlistForm id="hero" />
          <span className="text-[13.5px] text-muted">Free while in beta. No newsletters, no spam.</span>
        </div>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Platforms">
          {PLATFORMS.map((p) => (
            <li key={p} className="rounded-full border border-line bg-panel px-3 py-1 text-[13px] text-ink-2">
              {p}
            </li>
          ))}
        </ul>
      </section>

      <Section eyebrow="Where posts come from" title="Made from what you already do">
        <div className="grid gap-4 md:grid-cols-3">
          {SOURCES.map((s) => (
            <div key={s.title} className="flex flex-col gap-3 rounded-[18px] border border-line bg-panel p-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-accent-ink">
                <Icon name={s.icon} size={18} />
              </span>
              <h3 className="m-0 text-[17px] font-semibold">{s.title}</h3>
              <p className="m-0 text-[14.5px] text-muted">{s.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section eyebrow="How it works" title="Three steps, a few minutes a week">
        <ol className="m-0 grid list-none gap-4 p-0 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-2 rounded-[18px] border border-line bg-panel p-5">
              <span className="font-display text-[32px] font-semibold leading-none text-accent-ink">{i + 1}</span>
              <h3 className="m-0 text-[17px] font-semibold">{s.title}</h3>
              <p className="m-0 text-[14.5px] text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      <Section eyebrow="Who it's for" title="Anyone with work worth showing">
        <p className="m-0 max-w-2xl text-[16px] text-muted">
          Showrium started with developers, whose best work hides in repositories. It works just as well for anyone who does good work and
          doesn't have the time, the words or the confidence to post about it.
        </p>
        <ul className="m-0 flex list-none flex-wrap gap-2.5 p-0">
          {PEOPLE.map((p) => (
            <li key={p} className="rounded-xl border border-line bg-panel px-4 py-2.5 text-[15px] font-medium">
              {p}
            </li>
          ))}
        </ul>
      </Section>

      <Section eyebrow="Your rules" title="Built to be trusted with your name">
        <div className="grid gap-4 sm:grid-cols-2">
          {PROMISES.map((p) => (
            <div key={p.title} className="flex gap-4 rounded-[18px] border border-line bg-panel p-5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ok-soft text-ok">
                <Icon name={p.icon} size={18} />
              </span>
              <div className="flex flex-col gap-1">
                <h3 className="m-0 text-[16px] font-semibold">{p.title}</h3>
                <p className="m-0 text-[14.5px] text-muted">{p.body}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <section className="mb-14 flex flex-col items-start gap-4 rounded-[24px] border border-line bg-panel p-6 sm:p-10">
        <span className="eyebrow">Launching soon</span>
        <h2 className="text-[28px] font-semibold leading-tight sm:text-[36px]">Be one of the first to try it</h2>
        <p className="m-0 max-w-xl text-muted">We're letting people in a few at a time, so every invite gets a good first week.</p>
        <div className="w-full max-w-xl">
          <WaitlistForm id="footer" />
        </div>
      </section>
    </>
  );
}
