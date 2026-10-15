// The public website (showrium.com): what Showrium is, shown working, and the waitlist. It has no
// way into the app on purpose: testers get invite links, and the app lives at app.showrium.com.
import type { ReactNode } from "react";
import { WaitlistForm } from "../components/WaitlistForm";
import { Icon, type IconName } from "../ui/kit";
import { AutomationPlayground, HeroDemo, PlatformMarquee, PlatformShowcase, ProductTour } from "../marketing/demos";
import { Reveal, useReducedMotion } from "../marketing/motion";

const PLATFORMS = ["LinkedIn", "X", "Instagram", "Facebook", "Threads", "TikTok", "YouTube Shorts", "Bluesky", "Mastodon"];

const SOURCES: { icon: IconName; title: string; body: string }[] = [
  { icon: "git", title: "Your code", body: "Releases and each day's commits on a public GitHub repository." },
  { icon: "sources", title: "Your writing and videos", body: "A blog, a YouTube channel or a podcast. New pieces become posts that point back to them." },
  { icon: "photo", title: "Your day", body: "A photo of your work, a whiteboard, a PDF, a voice note, or one sentence answering today's question." },
];

const PEOPLE: { icon: IconName; label: string }[] = [
  { icon: "code", label: "Developers" },
  { icon: "automation", label: "Founders" },
  { icon: "edit", label: "Designers" },
  { icon: "play", label: "Creators and writers" },
  { icon: "ideas", label: "Teachers and students" },
  { icon: "insights", label: "Marketers" },
  { icon: "billing", label: "Small businesses" },
  { icon: "team", label: "Health and care workers" },
];

const PROMISES: { icon: IconName; title: string; body: string }[] = [
  { icon: "check", title: "You approve every post", body: "Drafts wait for you. Automation is something you switch on, per platform." },
  { icon: "comment", title: "It never talks for you", body: "No automatic replies, follows, likes or messages. Ever." },
  { icon: "lock", title: "Only where you already are", body: "Posts go only to the accounts you choose, through each platform's official tools." },
  { icon: "alert", title: "Honest by default", body: "No invented numbers or claims, no hashtag spam, and AI images and video are labelled." },
];

function Section({ eyebrow, title, intro, children, id }: { eyebrow: string; title: string; intro?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="flex flex-col gap-8 border-t border-line py-16 sm:py-24">
      <Reveal className="flex max-w-2xl flex-col gap-3">
        <span className="eyebrow">{eyebrow}</span>
        <h2 className="text-[30px] font-semibold leading-tight sm:text-[40px]">{title}</h2>
        {intro && <p className="m-0 text-[16.5px] text-muted">{intro}</p>}
      </Reveal>
      {children}
    </section>
  );
}

export function Home() {
  const reduced = useReducedMotion();
  return (
    <>
      <section className="relative isolate grid items-center gap-10 pb-12 pt-8 sm:pt-14 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.15fr)] lg:pb-20">
        {!reduced && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/2 -z-10 w-screen -translate-x-1/2 overflow-x-clip">
            <span className="mk-glow left-[8%] top-10 h-72 w-72 bg-accent" />
            <span className="mk-glow bottom-0 right-[10%] h-80 w-80 bg-info" style={{ animationDelay: "-6s" }} />
          </div>
        )}
        <div className="flex flex-col gap-6">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-accent/40 bg-accent-soft px-3 py-1 font-mono text-[12px] uppercase tracking-[0.12em] text-accent-ink">
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full bg-accent ${reduced ? "" : "mk-pulse"}`} />
            Launching soon
          </span>
          <h1 className="max-w-[14ch] text-[42px] font-semibold leading-[1.02] sm:text-[60px]">Show what you can do.</h1>
          <p className="lede">
            You do good work every day and almost nobody sees it. Showrium turns what you've already done, and what's on your mind, into posts for
            every platform you use, written in your own voice. You approve every one.
          </p>
          <div id="waitlist" className="flex max-w-xl scroll-mt-24 flex-col gap-2">
            <WaitlistForm id="hero" />
            <span className="text-[13.5px] text-muted">Free while in beta. No newsletters, no spam.</span>
          </div>
        </div>
        <HeroDemo />
      </section>

      <Reveal className="pb-6">
        <PlatformMarquee items={PLATFORMS} />
      </Reveal>

      <Section eyebrow="Where posts come from" title="Made from what you already do">
        <div className="grid gap-4 md:grid-cols-3">
          {SOURCES.map((s, i) => (
            <Reveal key={s.title} delay={i * 120} className="mk-tilt flex flex-col gap-3 rounded-[18px] border border-line bg-panel p-5">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
                <Icon name={s.icon} size={20} />
              </span>
              <h3 className="m-0 text-[17px] font-semibold">{s.title}</h3>
              <p className="m-0 text-[14.5px] text-muted">{s.body}</p>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section eyebrow="See it work" title="From idea to scheduled, in four steps" intro="This is the real app, in miniature. Pick a step, or let it play.">
        <Reveal>
          <ProductTour />
        </Reveal>
      </Section>

      <Section eyebrow="Every platform, its own format" title="One idea. Written the way each platform reads it." intro="A story on LinkedIn, a thread on X, a card on Instagram, something short on Bluesky. Each with an image in the shape that platform shows best.">
        <Reveal>
          <PlatformShowcase />
        </Reveal>
      </Section>

      <Section eyebrow="Automation you control" title="Switch on only what you want" intro="Try it: these are the same switches you get in the app. Each platform has its own, and nothing is automated until you say so.">
        <Reveal>
          <AutomationPlayground />
        </Reveal>
      </Section>

      <Section eyebrow="Who it's for" title="Anyone with work worth showing" intro="Showrium started with developers, whose best work hides in repositories. It works just as well for anyone who does good work and doesn't have the time, the words or the confidence to post about it.">
        <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 md:grid-cols-4">
          {PEOPLE.map((p, i) => (
            <Reveal as="li" key={p.label} delay={i * 60} className="mk-tilt flex items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-raised text-accent-ink"><Icon name={p.icon} size={17} /></span>
              <span className="text-[14.5px] font-medium">{p.label}</span>
            </Reveal>
          ))}
        </ul>
      </Section>

      <Section eyebrow="Your rules" title="Built to be trusted with your name">
        <div className="grid gap-4 sm:grid-cols-2">
          {PROMISES.map((p, i) => (
            <Reveal key={p.title} delay={i * 100} className="flex gap-4 rounded-[18px] border border-line bg-panel p-5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ok-soft text-ok">
                <Icon name={p.icon} size={18} />
              </span>
              <div className="flex flex-col gap-1">
                <h3 className="m-0 text-[16px] font-semibold">{p.title}</h3>
                <p className="m-0 text-[14.5px] text-muted">{p.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Reveal as="section" className="relative isolate mb-14 flex flex-col items-start gap-4 overflow-hidden rounded-[24px] border border-line bg-panel p-6 sm:p-10">
        {!reduced && <span aria-hidden="true" className="mk-glow -right-10 -top-10 -z-10 h-64 w-64 bg-accent" />}
        <span className="eyebrow">Launching soon</span>
        <h2 className="text-[30px] font-semibold leading-tight sm:text-[40px]">Be one of the first to try it</h2>
        <p className="m-0 max-w-xl text-muted">We're letting people in a few at a time, so every invite gets a good first week.</p>
        <div className="w-full max-w-xl">
          <WaitlistForm id="footer" />
        </div>
      </Reveal>
    </>
  );
}
