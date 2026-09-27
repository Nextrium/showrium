import type { ReactNode } from "react";
import { APP_ORIGIN, authClient, isWebsite, navigate, usePath } from "./lib";
import { Home } from "./pages/Home";
import { Invite } from "./pages/Invite";
import { Join } from "./pages/Join";
import { Privacy, Terms } from "./pages/Legal";
import { SignIn } from "./pages/SignIn";
import { Workspace } from "./pages/Workspace";

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  if (/^https?:/.test(to)) {
    return (
      <a href={to} className={className}>
        {children}
      </a>
    );
  }
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// Session cookies belong to app.showrium.com, so the website doesn't check sign-in state.
function WebsiteNav() {
  return (
    <Link to={`${APP_ORIGIN}/app`} className="button secondary">
      Sign in
    </Link>
  );
}

function AppNav({ path }: { path: string }) {
  const { data: session } = authClient.useSession();
  if (path === "/app" || path.startsWith("/app/")) return null;
  return session ? (
    <Link to="/app" className="button secondary">
      Open dashboard
    </Link>
  ) : (
    <Link to="/signin" className="button secondary">
      Sign in
    </Link>
  );
}

function TopBar({ path }: { path: string }) {
  return (
    <header className="topbar">
      <Link to={window.location.hostname === "app.showrium.com" ? "/app" : "/"} className="brand">
        <img src="/favicon.svg" alt="" />
        Showrium
      </Link>
      <nav className="nav" aria-label="Main">
        {isWebsite ? <WebsiteNav /> : <AppNav path={path} />}
      </nav>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <span>© {new Date().getFullYear()} Nextrium. Showrium is a Nextrium product.</span>
      <nav aria-label="Legal">
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
        <span>support@showrium.com</span>
      </nav>
    </footer>
  );
}

export function App() {
  const path = usePath();
  const page =
    path === "/app" || path.startsWith("/app/") ? <Workspace path={path} /> :
    path === "/signin" ? <SignIn /> :
    path === "/invite" ? <Invite /> :
    path === "/join" ? <Join /> :
    path === "/privacy" ? <Privacy /> :
    path === "/terms" ? <Terms /> :
    <Home />;
  return (
    <div className="page">
      <TopBar path={path} />
      <main>{page}</main>
      <Footer />
    </div>
  );
}
