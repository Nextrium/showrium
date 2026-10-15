// Live, animated miniatures of the real app for the marketing site. They use the app's own design
// tokens, so they match the product in light and dark mode. Examples are illustrative (no real
// people or numbers presented as results).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../ui/kit";
import { ErrorChart, PizzaFractions, PricingCoins } from "./illustrations";
import { AppWindow, Typewriter, useInView, usePageVisible, useReducedMotion } from "./motion";

/** Runs `steps` in order while active; returns the current step. Holds the last step when inactive. */
function useTimeline(durations: number[], active: boolean, key: unknown) {
  const [step, setStep] = useState(active ? 0 : durations.length - 1);
  const started = useRef(false);
  useEffect(() => setStep(active ? 0 : durations.length - 1), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // The first time it comes into view, play from the start (before that it shows the finished state).
  useEffect(() => {
    if (active && !started.current) {
      started.current = true;
      setStep(0);
    }
  }, [active]);
  useEffect(() => {
    if (!active || step >= durations.length - 1) return;
    const id = window.setTimeout(() => setStep((s) => s + 1), durations[step]);
    return () => window.clearTimeout(id);
  }, [active, step, durations]);
  return step;
}

const PLATFORM: Record<string, { label: string; tone: string }> = {
  linkedin: { label: "LinkedIn", tone: "bg-[#0a66c2] text-white" },
  x: { label: "X", tone: "bg-ink text-bg" },
  bluesky: { label: "Bluesky", tone: "bg-[#0560d0] text-white" },
  instagram: { label: "Instagram", tone: "bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af] text-white" },
  facebook: { label: "Facebook", tone: "bg-[#1260cf] text-white" },
};

// --- Hero: material in, a post for each platform out ------------------------------------------------

type Scenario = {
  id: string;
  who: string;
  source: { icon: IconName; kind: string; title: string; detail: string; art: ReactNode };
  posts: { platform: keyof typeof PLATFORM; text: string }[];
};
const SCENARIOS: Scenario[] = [
  {
    id: "dev",
    who: "A developer",
    source: { icon: "git", kind: "GitHub · today's commits", title: "queue-lite: retry backoff with jitter", detail: "13 commits · docs updated", art: <ErrorChart className="h-20 w-full text-accent-ink" /> },
    posts: [
      { platform: "linkedin", text: "We shipped smarter retries in queue-lite today. Before, a failed job retried instantly and hammered the database. Now each retry waits a little longer, with some randomness, so clients don't all retry at once." },
      { platform: "x", text: "Retries in queue-lite now back off with a bit of jitter. Fewer stampedes, a calmer database. Small change, big difference." },
      { platform: "bluesky", text: "Shipped: retry backoff with jitter in queue-lite. The kind of fix nobody notices until an outage, then everybody does." },
    ],
  },
  {
    id: "teacher",
    who: "A teacher",
    source: { icon: "photo", kind: "Your photo", title: "Fractions lesson, Year 5", detail: "\"They finally got it with pizza\"", art: <PizzaFractions className="h-24 w-full text-ink" /> },
    posts: [
      { platform: "linkedin", text: "My class finally understood fractions when I cut a pizza into eighths and let them eat the answers. Sometimes the best lesson plan is lunch." },
      { platform: "facebook", text: "Today's maths lesson came with toppings. Eight slices, twenty-four very focused students, and fractions that finally made sense." },
      { platform: "x", text: "Tried teaching fractions with an actual pizza today. 1/8 has never been so popular." },
    ],
  },
  {
    id: "founder",
    who: "A founder",
    source: { icon: "sources", kind: "Your blog", title: "How we priced our app for Nigeria", detail: "New article · 6 min read", art: <PricingCoins className="h-20 w-full text-ink" /> },
    posts: [
      { platform: "linkedin", text: "We almost copied our US pricing for Nigeria. Then we talked to forty customers. Here's what we changed, and why local payment methods mattered more than the price itself." },
      { platform: "x", text: "Pricing for Nigeria taught us one thing: the payment method matters as much as the price. Wrote up what we changed." },
      { platform: "bluesky", text: "New post: how we priced for Nigeria, and why we stopped converting dollars and started asking customers." },
    ],
  },
];
// Source in, writing, three posts typed, approved, scheduled, hold.
const HERO_STEPS = [900, 1100, 2300, 1900, 1900, 1000, 2800];

export function HeroDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const inView = useInView(ref);
  const visible = usePageVisible();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const active = !reduced && inView && visible && !paused;
  const step = useTimeline(HERO_STEPS, active, index);
  const s = SCENARIOS[index]!;

  // Move to the next example after the last step.
  useEffect(() => {
    if (!active || step < HERO_STEPS.length - 1) return;
    const id = window.setTimeout(() => setIndex((i) => (i + 1) % SCENARIOS.length), HERO_STEPS[HERO_STEPS.length - 1]);
    return () => window.clearTimeout(id);
  }, [active, step]);

  return (
    <div ref={ref} className="relative" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <p className="sr-only">
        An example of Showrium at work: {s.who.toLowerCase()} adds {s.source.kind.toLowerCase()}, "{s.source.title}", and Showrium writes a post for {s.posts.map((p) => PLATFORM[p.platform]!.label).join(", ")}, which they approve and schedule.
      </p>
      <div aria-hidden="true">
        <AppWindow path="/app/posts">
          <div className="grid gap-4 p-4 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)] sm:p-5">
            <div key={`src-${s.id}`} className="mk-pop flex flex-col gap-3 rounded-2xl border border-line bg-sunken p-4">
              <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-muted">
                <Icon name={s.source.icon} size={14} /> {s.source.kind}
              </span>
              <div className="rounded-xl bg-raised p-2">{s.source.art}</div>
              <span className="text-[14px] font-semibold leading-snug text-ink">{s.source.title}</span>
              <span className="text-[12.5px] text-muted">{s.source.detail}</span>
              <span className={`mt-auto flex items-center gap-2 text-[12.5px] font-medium ${step >= 1 ? "text-accent-ink" : "text-muted"}`}>
                <span className={`h-2 w-2 rounded-full ${step >= 1 && step < 5 ? "mk-pulse bg-accent" : step >= 5 ? "bg-ok" : "bg-line-strong"}`} />
                {step < 1 ? "New material" : step < 5 ? "Writing in your voice…" : "3 posts ready"}
              </span>
            </div>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {s.posts.map((p, i) => {
                const shown = step >= 2 + i;
                const typing = active && step === 2 + i;
                const meta = PLATFORM[p.platform]!;
                return (
                  <li key={`${s.id}-${i}`} className={`rounded-2xl border border-line bg-panel p-3 transition-all duration-500 ${shown ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"}`}>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className={`rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${meta.tone}`}>{meta.label}</span>
                      <span
                        className={`rounded-md border px-2 py-0.5 font-mono text-[10.5px] uppercase tracking-[0.1em] transition-colors duration-500 ${
                          step >= 6 ? "border-info/40 bg-info-soft text-info" : step >= 5 ? "border-ok/40 bg-ok-soft text-ok" : "border-accent/40 bg-accent-soft text-accent-ink"
                        }`}
                      >
                        {step >= 6 ? `Scheduled ${["Tue", "Wed", "Thu"][i]} 09:00` : step >= 5 ? "Approved" : "Draft"}
                      </span>
                    </div>
                    <p className="m-0 min-h-[3.2em] text-[13px] leading-snug text-ink-2">{shown ? <Typewriter text={p.text} play={typing} speed={16} /> : ""}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        </AppWindow>
      </div>
      <div className="mt-3 flex items-center justify-center gap-2">
        {SCENARIOS.map((x, i) => (
          <button
            key={x.id}
            type="button"
            aria-label={`Show the example for ${x.who.toLowerCase()}`}
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
            className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition-colors ${i === index ? "border-accent bg-accent-soft font-semibold text-ink" : "border-line bg-panel text-ink-2 hover:text-ink"}`}
          >
            {x.who}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Platform strip -----------------------------------------------------------------------------------

export function PlatformMarquee({ items }: { items: string[] }) {
  const reduced = useReducedMotion();
  const row = (hidden: boolean) => (
    <ul className="m-0 flex shrink-0 list-none gap-3 p-0 pr-3" aria-hidden={hidden || undefined}>
      {items.map((p) => (
        <li key={p} className="whitespace-nowrap rounded-full border border-line bg-panel px-4 py-1.5 text-[13.5px] font-medium text-ink-2">
          {p}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="mk-fade-edges relative overflow-hidden" aria-label="Platforms Showrium writes for">
      <div className={`flex w-max ${reduced ? "flex-wrap" : "mk-marquee"}`}>
        {row(false)}
        {!reduced && row(true)}
      </div>
    </div>
  );
}

// --- Tour: ideas → writing → image → schedule --------------------------------------------------------

const TOUR = [
  { id: "ideas", title: "Ideas find you", body: "Your sources, photos and answers become ideas, ranked by how post-worthy they are.", path: "/app/ideas" },
  { id: "write", title: "Posts are written", body: "One idea becomes a post or a thread for each platform, in your voice. Edit anything.", path: "/app/posts" },
  { id: "image", title: "An image is added", body: "Your photo, the link's own image, a designed card, or a labelled AI image, in each platform's shape.", path: "/app/posts" },
  { id: "schedule", title: "Approve and schedule", body: "Approve one by one or in a batch. Posts go out on the days and times you chose.", path: "/app/automation" },
] as const;

function TourIdeas({ play }: { play: boolean }) {
  const rows = [
    { icon: "git" as IconName, title: "13 commits on queue-lite", kind: "GitHub commits", fit: 85 },
    { icon: "photo" as IconName, title: "Fractions lesson, Year 5", kind: "Your photo", fit: 75 },
    { icon: "play" as IconName, title: "New video: Pricing for Nigeria", kind: "YouTube", fit: 68 },
  ];
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {rows.map((r, i) => (
        <li key={r.title} className={`flex items-center gap-3 rounded-xl border border-line bg-panel p-3 ${play ? "mk-slide-in" : ""}`} style={{ animationDelay: `${i * 220}ms` }}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-accent-ink"><Icon name={r.icon} size={16} /></span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13.5px] font-semibold">{r.title}</span>
            <span className="text-[12px] text-muted">{r.kind}</span>
          </span>
          <span className="rounded-md border border-ok/35 bg-ok-soft px-2 py-0.5 font-mono text-[10.5px] text-ok">FIT {r.fit}%</span>
        </li>
      ))}
    </ul>
  );
}

function TourWrite({ play }: { play: boolean }) {
  const parts = ["Retries used to fail silently. Here's what we changed.", "Each retry now waits a little longer than the last.", "A small random delay stops every client retrying at once."];
  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-2 text-[12.5px] text-muted">
        <span className="rounded-md bg-ink px-2 py-0.5 text-[11px] font-semibold text-bg">X</span> Thread · 3 parts
      </span>
      {parts.map((p, i) => (
        <div key={p} className={`rounded-xl border border-line bg-panel p-3 ${play ? "mk-slide-in" : ""}`} style={{ animationDelay: `${i * 500}ms` }}>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">Part {i + 1} of 3</span>
          <p className="m-0 mt-1 text-[13px] text-ink-2">{p}</p>
          <span className="text-[11.5px] text-muted">{p.length} / 280 characters</span>
        </div>
      ))}
    </div>
  );
}

function TourImage({ play }: { play: boolean }) {
  const shapes = [
    { id: "landscape", label: "Landscape · LinkedIn, X", ratio: "16 / 9" },
    { id: "square", label: "Square · Facebook", ratio: "1 / 1" },
    { id: "portrait", label: "Portrait · Instagram", ratio: "4 / 5" },
  ];
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!play) return;
    const id = window.setInterval(() => setI((x) => (x + 1) % shapes.length), 1300);
    return () => window.clearInterval(id);
  }, [play, shapes.length]);
  const s = shapes[i]!;
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="mk-morph flex w-full max-w-[300px] items-end overflow-hidden rounded-2xl bg-gradient-to-br from-[#16213A] to-[#2d4271] p-4" style={{ aspectRatio: s.ratio }}>
        <div className="flex w-full flex-col gap-2">
          <span className="h-1.5 w-10 rounded-full bg-accent" />
          <span className="font-display text-[15px] font-semibold leading-tight text-[#F5F6F8]">Retries used to fail silently. Here's what we changed.</span>
          <span className="text-[11px] text-[#AEB8CC]">Ada Builder</span>
        </div>
      </div>
      <span className="font-mono text-[11.5px] text-muted">{s.label}</span>
      <span className="flex gap-1.5 text-[12px]">
        <span className="rounded-md bg-raised px-2 py-0.5 text-ink-2">Designed card</span>
        <span className="rounded-md bg-raised px-2 py-0.5 text-ink-2">Alt text added</span>
      </span>
    </div>
  );
}

function TourSchedule({ play }: { play: boolean }) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const slots: Record<string, { p: string; tone: string }[]> = {
    Tue: [{ p: "LinkedIn", tone: "bg-[#0a66c2]" }],
    Wed: [{ p: "X", tone: "bg-ink !text-bg" }, { p: "Bluesky", tone: "bg-[#0560d0]" }],
    Fri: [{ p: "Facebook", tone: "bg-[#1260cf]" }],
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-7 gap-1.5">
        {days.map((d, di) => (
          <div key={d} className="flex min-h-28 flex-col gap-1 rounded-xl border border-line bg-panel p-1.5">
            <span className="text-center font-mono text-[10.5px] uppercase text-muted">{d}</span>
            {(slots[d] ?? []).map((s, si) => (
              <span key={s.p} className={`rounded-md px-1 py-1 text-center text-[10px] font-semibold text-white ${s.tone} ${play ? "mk-drop" : ""}`} style={{ animationDelay: `${(di * 2 + si) * 160}ms` }}>
                {s.p}
              </span>
            ))}
          </div>
        ))}
      </div>
      <span className="flex items-center gap-2 text-[12.5px] text-ok">
        <Icon name="check" size={14} strokeWidth={2.4} /> 4 posts approved in one tap · going out at 09:00
      </span>
    </div>
  );
}

export function ProductTour() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const inView = useInView(ref);
  const visible = usePageVisible();
  const [i, setI] = useState(0);
  const [manual, setManual] = useState(false);
  const auto = !reduced && inView && visible && !manual;
  const play = !reduced && inView;
  useEffect(() => {
    if (!auto) return;
    const id = window.setTimeout(() => setI((x) => (x + 1) % TOUR.length), 5200);
    return () => window.clearTimeout(id);
  }, [auto, i]);
  const step = TOUR[i]!;
  return (
    <div ref={ref} className="grid items-start gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
      <div role="tablist" aria-label="How Showrium works" className="flex flex-col gap-2">
        {TOUR.map((t, n) => (
          <button
            key={t.id}
            role="tab"
            id={`tour-tab-${t.id}`}
            aria-selected={n === i}
            aria-controls="tour-panel"
            onClick={() => {
              setI(n);
              setManual(true);
            }}
            className={`relative flex cursor-pointer flex-col gap-1 overflow-hidden rounded-2xl border p-4 text-left transition-colors ${n === i ? "border-accent/50 bg-panel" : "border-line bg-transparent hover:bg-panel"}`}
          >
            <span className="flex items-center gap-3">
              <span className={`flex h-7 w-7 items-center justify-center rounded-full font-mono text-[12px] font-semibold ${n === i ? "bg-accent text-on-accent" : "bg-raised text-muted"}`}>{n + 1}</span>
              <span className="text-[15.5px] font-semibold text-ink">{t.title}</span>
            </span>
            <span className={`pl-10 text-[14px] text-muted ${n === i ? "" : "hidden sm:block"}`}>{t.body}</span>
            {n === i && auto && <span key={`bar-${i}`} aria-hidden="true" className="mk-progress absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
          </button>
        ))}
      </div>
      <div id="tour-panel" role="tabpanel" aria-labelledby={`tour-tab-${step.id}`}>
        <AppWindow path={step.path}>
          <div key={step.id} className="mk-pop min-h-[320px] bg-sunken p-4 sm:p-5" aria-hidden="true">
            {step.id === "ideas" && <TourIdeas play={play} />}
            {step.id === "write" && <TourWrite play={play} />}
            {step.id === "image" && <TourImage play={play} />}
            {step.id === "schedule" && <TourSchedule play={play} />}
          </div>
        </AppWindow>
      </div>
    </div>
  );
}

// --- One idea, every platform's format ------------------------------------------------------------------

const SHOWCASE = ["linkedin", "x", "instagram", "bluesky"] as const;

function Author({ name, sub }: { name: string; sub: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-ink">A</span>
      <span className="flex flex-col leading-tight">
        <span className="text-[13.5px] font-semibold text-ink">{name}</span>
        <span className="text-[11.5px] text-muted">{sub}</span>
      </span>
    </div>
  );
}

function ShowcasePost({ platform }: { platform: (typeof SHOWCASE)[number] }) {
  if (platform === "linkedin") {
    return (
      <div className="flex flex-col gap-3">
        <Author name="Amaka Okafor" sub="Teacher · 1st" />
        <p className="m-0 text-[13.5px] leading-relaxed text-ink-2">
          My class finally understood fractions when I cut a pizza into eighths and let them eat the answers.
          <br />
          <br />
          What I learned: when an idea is abstract, make it something they can hold. Sometimes the best lesson plan is lunch.
        </p>
        <div className="flex aspect-[16/9] items-center justify-center rounded-xl bg-gradient-to-br from-accent-soft to-raised">
          <PizzaFractions className="h-[80%] text-ink" />
        </div>
        <span className="text-[12px] text-muted">Like · Comment · Repost</span>
      </div>
    );
  }
  if (platform === "x") {
    const parts = ["Tried teaching fractions with an actual pizza today.", "Cut into eighths. Every slice was a question. 1/8 has never been so popular.", "Abstract ideas stick when you can hold them. Or eat them."];
    return (
      <div className="flex flex-col">
        {parts.map((p, i) => (
          <div key={p} className="relative flex gap-3 pb-4">
            {i < parts.length - 1 && <span className="absolute left-[17px] top-10 h-[calc(100%-2.5rem)] w-0.5 bg-line-strong" aria-hidden="true" />}
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-ink">A</span>
            <div className="flex flex-col">
              <span className="text-[13px]"><strong className="text-ink">Amaka</strong> <span className="text-muted">@amaka_teaches · {i + 1}/3</span></span>
              <p className="m-0 text-[13.5px] text-ink-2">{p}</p>
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (platform === "instagram") {
    return (
      <div className="mx-auto flex w-full max-w-[280px] flex-col gap-2">
        <Author name="amaka.teaches" sub="Lagos" />
        <div className="flex aspect-[4/5] flex-col justify-between rounded-xl bg-gradient-to-br from-[#16213A] to-[#2d4271] p-4">
          <span className="font-display text-[19px] font-semibold leading-tight text-[#F5F6F8]">The day fractions finally made sense.</span>
          <PizzaFractions className="h-44 self-center text-[#F5F6F8]" />
        </div>
        <p className="m-0 text-[12.5px] text-ink-2"><strong>amaka.teaches</strong> Eight slices, twenty-four focused students. Save this for your next maths lesson.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Author name="Amaka Okafor" sub="@amaka.bsky.social" />
      <p className="m-0 text-[13.5px] text-ink-2">Taught fractions with a pizza cut into eighths today. The class that "hates maths" asked for more. Lesson notes in the replies.</p>
      <div className="flex aspect-[16/9] items-center justify-center rounded-xl bg-raised">
        <PizzaFractions className="h-[80%] text-ink" />
      </div>
    </div>
  );
}

export function PlatformShowcase() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const inView = useInView(ref);
  const visible = usePageVisible();
  const [i, setI] = useState(0);
  const [manual, setManual] = useState(false);
  useEffect(() => {
    if (reduced || !inView || !visible || manual) return;
    const id = window.setTimeout(() => setI((x) => (x + 1) % SHOWCASE.length), 4200);
    return () => window.clearTimeout(id);
  }, [reduced, inView, visible, manual, i]);
  const p = SHOWCASE[i]!;
  return (
    <div ref={ref} className="flex flex-col items-center gap-5">
      <div role="tablist" aria-label="See the same idea on each platform" className="flex flex-wrap justify-center gap-2">
        {SHOWCASE.map((x, n) => (
          <button
            key={x}
            role="tab"
            aria-selected={n === i}
            aria-controls="showcase-panel"
            id={`showcase-${x}`}
            onClick={() => {
              setI(n);
              setManual(true);
            }}
            className={`cursor-pointer rounded-full px-4 py-1.5 text-[13.5px] font-semibold transition-colors ${n === i ? PLATFORM[x]!.tone : "border border-line bg-panel text-ink-2 hover:text-ink"}`}
          >
            {PLATFORM[x]!.label}
          </button>
        ))}
      </div>
      <div id="showcase-panel" role="tabpanel" aria-labelledby={`showcase-${p}`} className="w-full max-w-[460px]">
        <div key={p} className="mk-pop rounded-[20px] border border-line bg-panel p-5 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.4)]">
          <ShowcasePost platform={p} />
        </div>
      </div>
    </div>
  );
}

// --- Automation you can try -------------------------------------------------------------------------------

type Rule = { write: boolean; schedule: boolean; approve: boolean };
const AUTO_PLATFORMS = [
  { id: "linkedin", label: "LinkedIn" },
  { id: "x", label: "X" },
  { id: "bluesky", label: "Bluesky" },
] as const;
const MIX = [
  { id: "build", label: "Build in public", tone: "bg-accent" },
  { id: "teach", label: "Teach", tone: "bg-info" },
  { id: "smile", label: "Smile", tone: "bg-ok" },
] as const;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Toggle({ on, onChange, label, disabled, note }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; note?: string | undefined }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      title={note}
      onClick={() => onChange(!on)}
      className={`flex h-[24px] w-10 shrink-0 cursor-pointer rounded-full p-[3px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${on ? "justify-end bg-accent" : "justify-start bg-line-strong"}`}
    >
      <span className={`h-[18px] w-[18px] rounded-full transition-transform ${on ? "bg-on-accent" : "bg-ink-2"}`} />
    </button>
  );
}

export function AutomationPlayground() {
  const [rules, setRules] = useState<Record<string, Rule>>({
    linkedin: { write: true, schedule: true, approve: false },
    x: { write: true, schedule: false, approve: false },
    bluesky: { write: true, schedule: true, approve: true },
  });
  const [mix, setMix] = useState<Record<string, number>>({ build: 2, teach: 1, smile: 1 });
  const [days, setDays] = useState<string[]>(["Tue", "Thu", "Sat"]);
  const writing = AUTO_PLATFORMS.filter((p) => rules[p.id]!.write);
  const approving = writing.filter((p) => rules[p.id]!.approve);
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  // Spread the week's posts over the chosen days, in mix order.
  const plan = useMemo(() => {
    const queue = MIX.flatMap((m) => Array.from({ length: mix[m.id] ?? 0 }, () => m));
    const out: Record<string, (typeof MIX)[number][]> = {};
    const chosen = DAYS.filter((d) => days.includes(d));
    queue.forEach((m, n) => {
      const d = chosen[n % Math.max(1, chosen.length)];
      if (d) (out[d] ??= []).push(m);
    });
    return out;
  }, [mix, days]);
  const set = (id: string, key: keyof Rule, v: boolean) =>
    setRules((r) => {
      const next = { ...r[id]!, [key]: v };
      if (key === "write" && !v) next.approve = false;
      return { ...r, [id]: next };
    });

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
      <div className="flex flex-col gap-3 rounded-[20px] border border-line bg-panel p-4 sm:p-5">
        <div className="grid grid-cols-[minmax(0,1fr)_repeat(3,64px)] items-center gap-y-3 text-[12px] text-muted sm:grid-cols-[minmax(0,1fr)_repeat(3,96px)]">
          <span />
          <span className="text-center">Write drafts</span>
          <span className="text-center">Schedule when approved</span>
          <span className="text-center">Approve for me</span>
          {AUTO_PLATFORMS.map((p) => (
            <div key={p.id} className="contents">
              <span className="text-[14px] font-semibold text-ink">{p.label}</span>
              {(["write", "schedule", "approve"] as const).map((k) => {
                const locked = k === "approve" && (p.id === "x" || !rules[p.id]!.write);
                return (
                  <span key={k} className="flex justify-center">
                    <Toggle
                      on={rules[p.id]![k]}
                      disabled={locked}
                      note={p.id === "x" && k === "approve" ? "X requires your approval" : undefined}
                      label={`${k === "write" ? "Write drafts" : k === "schedule" ? "Schedule when approved" : "Approve for me"} on ${p.label}`}
                      onChange={(v) => set(p.id, k, v)}
                    />
                  </span>
                );
              })}
            </div>
          ))}
        </div>
        <hr className="m-0 border-line" />
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-ink-2">Weekly style mix</span>
          {MIX.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-[13.5px]"><span className={`h-2.5 w-2.5 rounded-full ${m.tone}`} />{m.label}</span>
              <span className="flex items-center gap-2">
                <button type="button" aria-label={`Fewer ${m.label}`} disabled={(mix[m.id] ?? 0) <= 0} onClick={() => setMix((x) => ({ ...x, [m.id]: (x[m.id] ?? 0) - 1 }))} className="h-7 w-7 cursor-pointer rounded-lg border border-line-strong bg-raised disabled:opacity-40">−</button>
                <span className="w-4 text-center font-mono" aria-live="polite">{mix[m.id]}</span>
                <button type="button" aria-label={`More ${m.label}`} disabled={(mix[m.id] ?? 0) >= 4} onClick={() => setMix((x) => ({ ...x, [m.id]: (x[m.id] ?? 0) + 1 }))} className="h-7 w-7 cursor-pointer rounded-lg border border-line-strong bg-raised disabled:opacity-40">+</button>
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Posting days">
          {DAYS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days.includes(d)}
              onClick={() => setDays((x) => (x.includes(d) ? x.filter((y) => y !== d) : [...x, d]))}
              className={`cursor-pointer rounded-full border px-3 py-1 text-[12.5px] ${days.includes(d) ? "border-accent bg-accent-soft font-semibold text-ink" : "border-line text-muted"}`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4 rounded-[20px] border border-line bg-sunken p-4 sm:p-5">
        <p className="m-0 text-[15px] leading-relaxed text-ink" aria-live="polite">
          {!writing.length || !total
            ? "Showrium finds ideas. You decide what to write."
            : `Each week, ${total} post${total === 1 ? "" : "s"} written for ${writing.map((p) => p.label).join(", ")}. ${approving.length ? `${approving.map((p) => p.label).join(" and ")} ${approving.length === 1 ? "is" : "are"} approved for you; the rest wait for you.` : "You approve every one."}`}
        </p>
        <div className="grid grid-cols-7 gap-1" aria-hidden="true">
          {DAYS.map((d) => (
            <div key={d} className={`flex min-h-24 flex-col items-center gap-1 rounded-lg border p-1 ${days.includes(d) ? "border-line bg-panel" : "border-dashed border-line-strong bg-transparent"}`}>
              <span className="font-mono text-[10px] uppercase text-muted">{d}</span>
              {(plan[d] ?? []).map((m, n) => (
                <span key={`${d}-${m.id}-${n}`} className={`mk-drop h-3 w-full rounded ${m.tone}`} title={m.label} />
              ))}
            </div>
          ))}
        </div>
        <span className="text-[12.5px] text-muted">Replies are never automated, and nothing is posted on X without your approval.</span>
      </div>
    </div>
  );
}
