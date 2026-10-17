import { useEffect, useState, type ReactNode } from "react";
import { Alert, Loading, useLoad } from "./ui";
import { Overview } from "./pages/Overview";
import { Waitlist } from "./pages/Waitlist";
import { Users } from "./pages/Users";
import { Staff } from "./pages/Staff";
import { Activity } from "./pages/Activity";

export type Me = { email: string; role: "owner" | "support" | "finance"; permissions: string[]; appUrl: string };

const PAGES: { path: string; label: string; permission: string; render: (me: Me) => ReactNode }[] = [
  { path: "/", label: "Overview", permission: "overview", render: () => <Overview /> },
  { path: "/waitlist", label: "Waitlist", permission: "waitlist", render: () => <Waitlist /> },
  { path: "/users", label: "Users", permission: "users", render: (me) => <Users me={me} /> },
  { path: "/staff", label: "Staff", permission: "staff", render: (me) => <Staff me={me} /> },
  { path: "/activity", label: "Activity", permission: "audit", render: () => <Activity /> },
];

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const go = (to: string) => {
    window.history.pushState(null, "", to);
    setPath(to);
  };
  return [path, go] as const;
}

export function App() {
  const { data: me, error } = useLoad<Me>("/me");
  const [path, go] = usePath();
  if (error) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 p-6">
        <h1 className="m-0 font-display text-2xl">Showrium Admin</h1>
        <Alert>{error}</Alert>
      </main>
    );
  }
  if (!me) return <main className="p-6"><Loading /></main>;
  const pages = PAGES.filter((p) => me.permissions.includes(p.permission));
  const page = pages.find((p) => p.path === path) ?? pages[0];

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-30 focus:rounded-lg focus:bg-panel focus:p-2">
        Skip to content
      </a>
      <aside className="flex flex-col gap-4 border-b border-line bg-[var(--sidebar)] p-4 md:min-h-dvh md:border-b-0 md:border-r">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent font-display font-bold text-on-accent">S</span>
          <span className="font-display text-[17px] font-semibold">Admin</span>
        </div>
        <nav aria-label="Admin" className="flex gap-1 overflow-x-auto md:flex-col">
          {pages.map((p) => (
            <a
              key={p.path}
              href={p.path}
              aria-current={page?.path === p.path ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(p.path);
              }}
              className={`whitespace-nowrap rounded-lg px-3 py-2 text-[14px] font-medium no-underline ${page?.path === p.path ? "bg-[var(--selected)] text-ink" : "text-ink-2 hover:bg-raised"}`}
            >
              {p.label}
            </a>
          ))}
        </nav>
        <div className="mt-auto hidden flex-col gap-0.5 text-[12.5px] text-muted md:flex">
          <span className="truncate text-ink-2">{me.email}</span>
          <span className="capitalize">{me.role}</span>
          <a href={me.appUrl} className="text-accent-ink">Open Showrium ↗</a>
        </div>
      </aside>
      <main id="main" className="flex min-w-0 flex-col gap-4 p-4 md:p-6">
        <h1 className="m-0 font-display text-[26px] font-semibold">{page?.label ?? "Admin"}</h1>
        {page ? page.render(me) : <p className="m-0 text-muted">Your role has no pages yet.</p>}
      </main>
    </div>
  );
}
