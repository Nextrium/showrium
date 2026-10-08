// Motion building blocks for the marketing site. Every animation:
// - runs only while it's on screen (saves battery, and nothing moves out of sight),
// - stops for people who ask their device for less motion (they get the finished state),
// - is decorative: the meaning is always in the text too.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** True while the element is on screen (or once, with `once`). */
export function useInView<T extends Element>(ref: RefObject<T | null>, opts: { once?: boolean; margin?: string } = {}): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          if (opts.once) io.disconnect();
        } else if (!opts.once) setInView(false);
      },
      { rootMargin: opts.margin ?? "0px 0px -10% 0px", threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, opts.once, opts.margin]);
  return inView;
}

/** True while the page is visible (animations pause in background tabs). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/** Fades and lifts its children in the first time they scroll into view. */
export function Reveal({ children, delay = 0, className = "", as: Tag = "div" }: { children: ReactNode; delay?: number; className?: string; as?: "div" | "section" | "li" }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const shown = useInView(ref, { once: true });
  return (
    <Tag ref={ref as never} className={`${reduced ? "" : "mk-reveal"} ${shown || reduced ? "mk-shown" : ""} ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </Tag>
  );
}

/** Types `text` out while `play` is true; shows it whole otherwise. */
export function Typewriter({ text, play, speed = 18, onDone }: { text: string; play: boolean; speed?: number; onDone?: () => void }) {
  const [n, setN] = useState(play ? 0 : text.length);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!play) {
      setN(text.length);
      return;
    }
    setN(0);
    let i = 0;
    const id = window.setInterval(() => {
      i += Math.max(1, Math.round(text.length / 120));
      setN(Math.min(text.length, i));
      if (i >= text.length) {
        window.clearInterval(id);
        done.current?.();
      }
    }, speed);
    return () => window.clearInterval(id);
  }, [text, play, speed]);
  return (
    <>
      {text.slice(0, n)}
      {play && n < text.length && <span className="mk-caret" aria-hidden="true" />}
    </>
  );
}

/** A browser-style frame around an app replica. */
export function AppWindow({ path, children, className = "" }: { path: string; children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-[20px] border border-line-strong bg-panel shadow-[0_30px_80px_-30px_rgba(0,0,0,0.45)] ${className}`}>
      <div className="flex items-center gap-2 border-b border-line bg-raised px-4 py-2.5" aria-hidden="true">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-3 truncate rounded-md bg-sunken px-3 py-0.5 font-mono text-[11.5px] text-muted">app.showrium.com{path}</span>
      </div>
      {children}
    </div>
  );
}
