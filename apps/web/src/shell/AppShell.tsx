// The signed-in app frame. Responsive:
// - phones (< 768 px): top bar, bottom tab bar with a central "New post" button, "More" opens the menu
// - tablets (768–1023 px): an icon rail; the menu button opens the full sidebar over the page
// - desktops (≥ 1024 px): the full sidebar, collapsible to the icon rail (remembered per browser)
import { useEffect, useRef, useState, type ReactNode } from "react";
import { authClient, currentOrgId, getTheme, navigate, setTheme, switchWorkspace, useApi, type ThemeChoice } from "../lib";
import { Link } from "../ui/Link";
import { Icon, type IconName } from "../ui/kit";

type Me = { principal: { kind: string; role: string; isPlatformAdmin: boolean }; workspace: { id: string; name: string; plan: string; fullAccess: boolean } };
type Workspace = { id: string; name: string; plan: string; role: string; personal: boolean };
type NavItem = { to: string; label: string; icon: IconName; badge?: number | undefined; match?: string[] | undefined };

export function planLabel(plan: string, fullAccess?: boolean) {
  if (fullAccess || plan === "staff") return "Full access";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

function useNavSections(me: Me | null): { label: string; items: NavItem[] }[] {
  const { data: summary } = useApi<{ drafts: number; ideas: number }>(me ? "/summary" : null);
  const manager = me?.principal.role === "owner" || me?.principal.role === "admin";
  return [
    {
      label: "Create",
      items: [
        { to: "/app", label: "Home", icon: "home" },
        { to: "/app/posts", label: "Posts", icon: "posts", badge: summary?.drafts, match: ["/app/drafts"] },
        { to: "/app/ideas", label: "Ideas", icon: "ideas", badge: summary?.ideas },
        { to: "/app/studio", label: "Video", icon: "video" },
      ],
    },
    { label: "Grow", items: [{ to: "/app/insights", label: "Insights", icon: "insights" }] },
    {
      label: "Setup",
      items: [
        { to: "/app/sources", label: "Sources", icon: "sources" },
        { to: "/app/accounts", label: "Accounts", icon: "accounts" },
        { to: "/app/voice", label: "Brand voice", icon: "voice" },
        { to: "/app/automation", label: "Automation", icon: "automation" },
      ],
    },
    {
      label: "Workspace",
      items: [
        { to: "/app/team", label: "Team", icon: "team" },
        { to: "/app/billing", label: "Billing & usage", icon: "billing" },
        { to: "/app/settings", label: "Settings", icon: "settings" },
        ...(manager ? [{ to: "/app/audit", label: "Audit log", icon: "audit" as IconName }] : []),
      ],
    },
  ];
}

const isActive = (path: string, item: NavItem) =>
  item.to === "/app" ? path === "/app" : path === item.to || path.startsWith(`${item.to}/`) || Boolean(item.match?.includes(path));

function NavLinks({ path, sections, compact, onNavigate }: { path: string; sections: { label: string; items: NavItem[] }[]; compact: boolean; onNavigate?: (() => void) | undefined }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-2">
      {sections.map((sec) => (
        <div key={sec.label} className="flex flex-col gap-0.5">
          <span className={`px-2.5 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted ${compact ? "sr-only" : ""}`}>{sec.label}</span>
          {sec.items.map((item) => {
            const active = isActive(path, item);
            return (
              <Link
                key={item.to}
                to={item.to}
                ariaCurrent={active}
                title={compact ? item.label : undefined}
                ariaLabel={compact ? item.label : undefined}
                onNavigate={onNavigate}
                className={`relative flex h-9 items-center gap-3 rounded-[10px] text-[14.5px] no-underline transition-colors ${compact ? "justify-center px-0" : "px-2.5"} ${
                  active ? "bg-selected font-semibold text-ink" : "text-ink-2 hover:bg-raised hover:text-ink"
                }`}
              >
                <Icon name={item.icon} />
                {!compact && <span className="flex-1 truncate">{item.label}</span>}
                {!!item.badge &&
                  (compact ? (
                    <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-accent" aria-label={`${item.badge} new`} />
                  ) : (
                    <span className="rounded-full bg-raised px-2 font-mono text-[11.5px] text-ink-2">{item.badge}</span>
                  ))}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function ThemePicker() {
  const [theme, setChoice] = useState<ThemeChoice>(getTheme());
  const options: [ThemeChoice, IconName, string][] = [["light", "sun", "Light"], ["dark", "moon", "Dark"], ["system", "monitor", "System"]];
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-sunken p-1">
      {options.map(([id, icon, label]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={theme === id}
          onClick={() => {
            setTheme(id);
            setChoice(id);
          }}
          className={`flex min-h-9 cursor-pointer items-center justify-center gap-1.5 rounded-[9px] border-0 text-[13px] ${theme === id ? "bg-selected font-semibold text-ink" : "bg-transparent text-muted hover:text-ink"}`}
        >
          <Icon name={icon} size={15} />
          {label}
        </button>
      ))}
    </div>
  );
}

function AccountMenuBody({ me, onClose }: { me: Me | null; onClose: () => void }) {
  const { data: session } = authClient.useSession();
  const { data: ws } = useApi<{ data: Workspace[] }>("/workspaces");
  const current = currentOrgId() ?? me?.workspace.id;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col">
        <span className="truncate font-semibold">{session?.user.name}</span>
        <span className="truncate text-[13px] text-muted">{session?.user.email}</span>
      </div>
      {ws && ws.data.length > 1 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Workspaces</span>
          {ws.data.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => w.id !== current && switchWorkspace(w.id)}
              className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-[10px] border-0 px-2.5 text-left text-sm ${w.id === current ? "bg-selected font-semibold text-ink" : "bg-transparent text-ink-2 hover:bg-raised"}`}
            >
              <span className="flex-1 truncate">{w.name}</span>
              <span className="text-xs text-muted">{w.role}</span>
              {w.id === current && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      )}
      <ThemePicker />
      <div className="flex flex-col gap-1 border-t border-line pt-2">
        <Link to="/app/settings" onNavigate={onClose} className="flex min-h-10 items-center gap-2 rounded-[10px] px-2.5 text-sm text-ink-2 no-underline hover:bg-raised">
          <Icon name="settings" size={16} /> Settings
        </Link>
        <button
          type="button"
          onClick={async () => {
            await authClient.signOut();
            navigate("/");
          }}
          className="flex min-h-10 cursor-pointer items-center gap-2 rounded-[10px] border-0 bg-transparent px-2.5 text-left text-sm text-ink-2 hover:bg-raised"
        >
          <Icon name="logout" size={16} /> Sign out
        </button>
      </div>
    </div>
  );
}

function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open, close, ref]);
}

function AccountButton({ me, compact }: { me: Me | null; compact: boolean }) {
  const { data: session } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);
  const initial = (session?.user.name ?? "?").trim().charAt(0).toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Account and workspace"
        onClick={() => setOpen(!open)}
        className={`flex w-full cursor-pointer items-center gap-2.5 rounded-xl border-0 bg-transparent py-2 text-left text-ink hover:bg-raised ${compact ? "justify-center px-0" : "px-2"}`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-selected text-sm font-semibold">{initial}</span>
        {!compact && (
          <>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-semibold">{session?.user.name}</span>
              <span className="truncate text-[12.5px] text-muted">{me ? `${me.workspace.name} · ${planLabel(me.workspace.plan, me.workspace.fullAccess)}` : " "}</span>
            </span>
            <Icon name="chevrons" size={16} className="text-muted" />
          </>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Account" className="absolute bottom-full left-0 z-40 mb-2 w-72 rounded-2xl border border-line-strong bg-panel p-4 shadow-card">
          <AccountMenuBody me={me} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function Brand({ compact }: { compact: boolean }) {
  return (
    <Link to="/app" ariaLabel="Showrium home" className="flex items-center gap-2.5 text-ink no-underline">
      <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent font-display text-lg font-bold text-on-accent">S</span>
      {!compact && <span className="font-display text-[19px] font-bold">Showrium</span>}
    </Link>
  );
}

function SidebarBody({ path, me, sections, compact, onToggle, onNavigate }: {
  path: string;
  me: Me | null;
  sections: { label: string; items: NavItem[] }[];
  compact: boolean;
  onToggle?: (() => void) | undefined;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <div className="flex h-full flex-col gap-2 px-3 py-4">
      <div className={`flex items-center border-b border-line pb-3 ${compact ? "flex-col gap-3" : "justify-between px-1.5"}`}>
        <Brand compact={compact} />
        {onToggle && (
          <button type="button" onClick={onToggle} aria-label={compact ? "Expand sidebar" : "Collapse sidebar"} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-line bg-transparent text-muted hover:text-ink">
            <Icon name={compact ? "expand" : "collapse"} size={16} />
          </button>
        )}
      </div>
      <div className="-mx-1 flex-1 overflow-y-auto px-1 [scrollbar-width:thin]">
        <NavLinks path={path} sections={sections} compact={compact} onNavigate={onNavigate} />
      </div>
      <Link
        to="/app/new"
        onNavigate={onNavigate}
        ariaLabel={compact ? "New post" : undefined}
        title={compact ? "New post" : undefined}
        className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent text-[15px] font-semibold text-on-accent no-underline hover:bg-accent-hover"
      >
        <Icon name="plus" size={18} strokeWidth={2.2} />
        {!compact && "New post"}
      </Link>
      <div className="border-t border-line pt-2">
        <AccountButton me={me} compact={compact} />
      </div>
    </div>
  );
}

const NAV_KEY = "showrium_nav_collapsed";

export function AppShell({ path, children }: { path: string; children: ReactNode }) {
  const { data: me } = useApi<Me>("/me");
  const sections = useNavSections(me);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  useDismiss(drawer, () => setDrawer(false), drawerRef);
  useEffect(() => setDrawer(false), [path]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(NAV_KEY, next ? "1" : "0");
    } catch {
      // Not remembered; fine.
    }
  };

  const tabs: NavItem[] = [
    { to: "/app", label: "Home", icon: "home" },
    { to: "/app/posts", label: "Posts", icon: "posts", match: ["/app/drafts"] },
    { to: "/app/new", label: "New", icon: "plus" },
    { to: "/app/ideas", label: "Ideas", icon: "ideas" },
  ];

  return (
    <div className="min-h-dvh bg-bg text-ink md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-panel focus:px-3 focus:py-2">Skip to content</a>

      {/* Tablet rail and desktop sidebar */}
      <aside className={`sticky top-0 hidden h-dvh shrink-0 border-r border-line bg-sidebar md:block ${collapsed ? "w-[76px]" : "w-[76px] lg:w-64"}`}>
        <div className="hidden h-full lg:block">
          <SidebarBody path={path} me={me} sections={sections} compact={collapsed} onToggle={toggle} />
        </div>
        <div className="h-full lg:hidden">
          <div className="flex h-full flex-col items-center gap-2 py-4">
            <button type="button" onClick={() => setDrawer(true)} aria-label="Open menu" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-line bg-transparent text-ink-2">
              <Icon name="menu" />
            </button>
            <div className="w-full flex-1 overflow-y-auto px-3">
              <NavLinks path={path} sections={sections} compact />
            </div>
            <Link to="/app/new" ariaLabel="New post" title="New post" className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-on-accent">
              <Icon name="plus" strokeWidth={2.2} />
            </Link>
            <div className="w-full border-t border-line px-3 pt-2">
              <AccountButton me={me} compact />
            </div>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phone top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-sidebar/95 px-4 py-2.5 backdrop-blur md:hidden">
          <Brand compact={false} />
          <button type="button" onClick={() => setDrawer(true)} aria-label="Open menu" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-line bg-transparent text-ink-2">
            <Icon name="menu" />
          </button>
        </header>
        <main id="main" className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-6 px-4 pb-28 pt-5 sm:px-6 md:px-8 md:pb-12 md:pt-8">
          {children}
        </main>
      </div>

      {/* Phone tab bar */}
      <nav aria-label="Quick" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 items-center border-t border-line bg-sidebar/95 pb-[max(6px,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur md:hidden">
        {tabs.map((t) =>
          t.to === "/app/new" ? (
            <Link key={t.to} to={t.to} ariaLabel="New post" className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent text-on-accent">
              <Icon name="plus" size={22} strokeWidth={2.2} />
            </Link>
          ) : (
            <Link key={t.to} to={t.to} ariaCurrent={isActive(path, t)} className={`flex flex-col items-center gap-0.5 py-1 text-[11.5px] no-underline ${isActive(path, t) ? "font-semibold text-ink" : "text-muted"}`}>
              <Icon name={t.icon} size={20} />
              {t.label}
            </Link>
          ),
        )}
        <button type="button" onClick={() => setDrawer(true)} className="flex cursor-pointer flex-col items-center gap-0.5 border-0 bg-transparent py-1 text-[11.5px] text-muted">
          <Icon name="menu" size={20} />
          More
        </button>
      </nav>

      {/* Menu drawer (phones and tablets) */}
      {drawer && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden">
          <div ref={drawerRef} role="dialog" aria-modal="true" aria-label="Menu" className="flex h-full w-[min(88vw,320px)] flex-col overflow-y-auto border-r border-line bg-sidebar">
            <div className="flex justify-end px-3 pt-3">
              <button type="button" onClick={() => setDrawer(false)} aria-label="Close menu" className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-line bg-transparent text-ink-2">
                <Icon name="close" />
              </button>
            </div>
            <div className="flex-1">
              <SidebarBody path={path} me={me} sections={sections} compact={false} onNavigate={() => setDrawer(false)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
