import type { ReactNode } from "react";
import { APP_ORIGIN, authClient, isWebsite, navigate, usePath } from "./lib";
import { Dashboard } from "./pages/Dashboard";
import { Home } from "./pages/Home";
import { Privacy, Terms } from "./pages/Legal";
import { SignIn } from "./pages/SignIn";

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

function AppNav() {
  const { data: session } = authClient.useSession();
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

function TopBar() {
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <img src="/favicon.svg" alt="" />
        Showrium
      </Link>
      <nav className="nav" aria-label="Main">
        {isWebsite ? <WebsiteNav /> : <AppNav />}
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

const APP_PATHS = new Set(["/app", "/signin"]);

export function App() {
  const path = usePath();
  if (isWebsite && APP_PATHS.has(path)) {
    window.location.replace(`${APP_ORIGIN}${path}`);
    return null;
  }
  if (window.location.hostname === "app.showrium.com" && path === "/") {
    navigate("/app");
    return null;
  }
  const page =
    path === "/app" ? <Dashboard /> :
    path === "/signin" ? <SignIn /> :
    path === "/privacy" ? <Privacy /> :
    path === "/terms" ? <Terms /> :
    <Home />;
  return (
    <div className="page">
      <TopBar />
      <main>{page}</main>
      <Footer />
    </div>
  );
}
