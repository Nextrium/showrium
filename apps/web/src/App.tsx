import type { ReactNode } from "react";
import { authClient, navigate, usePath } from "./lib";
import { Dashboard } from "./pages/Dashboard";
import { Home } from "./pages/Home";
import { Privacy, Terms } from "./pages/Legal";
import { SignIn } from "./pages/SignIn";

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
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

function TopBar() {
  const { data: session } = authClient.useSession();
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <img src="/favicon.svg" alt="" />
        Showrium
      </Link>
      <nav className="nav" aria-label="Main">
        {session ? (
          <Link to="/app" className="button secondary">
            Open dashboard
          </Link>
        ) : (
          <Link to="/signin" className="button secondary">
            Sign in
          </Link>
        )}
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
