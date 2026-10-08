import { lazy, Suspense } from "react";
import { authClient, isWebsite, usePath } from "./lib";
import { Link } from "./ui/Link";
import { Home } from "./pages/Home";
import { Invite } from "./pages/Invite";
import { Join } from "./pages/Join";
import { Privacy, Terms } from "./pages/Legal";
import { SignIn } from "./pages/SignIn";
import { ResetPassword } from "./pages/ResetPassword";
// The signed-in app is loaded only when needed, so the website stays light for visitors.
const Workspace = lazy(() => import("./pages/Workspace").then((m) => ({ default: m.Workspace })));

export { Link } from "./ui/Link";

// The website only collects the waitlist; it has no way into the app (testers get invite links).
function WebsiteNav() {
  return (
    <a href="#waitlist" className="button secondary">
      Launching soon
    </a>
  );
}

function AppNav({ path }: { path: string }) {
  const { data: session } = authClient.useSession();
  // The invite page handles signed-in visitors itself: a dashboard link there would skip the invite.
  if (path === "/app" || path.startsWith("/app/") || path === "/invite") return null;
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
        {isWebsite || path === "/" ? <WebsiteNav /> : <AppNav path={path} />}
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
  // The signed-in app has its own full-screen shell (sidebar, tab bar), not the website frame.
  if (path === "/app" || path.startsWith("/app/")) {
    return (
      <Suspense fallback={<p role="status" className="grid min-h-dvh place-items-center text-sm text-muted">Opening your workspace…</p>}>
        <Workspace path={path} />
      </Suspense>
    );
  }
  // app.showrium.com has no marketing page: its front door is the app (which asks you to sign in).
  if (path === "/" && window.location.hostname === "app.showrium.com") {
    window.location.replace("/app");
    return null;
  }
  const page =
    path === "/signin" ? <SignIn /> :
    path === "/invite" ? <Invite /> :
    path === "/reset-password" ? <ResetPassword /> :
    path === "/join" ? <Join /> :
    path === "/privacy" ? <Privacy /> :
    path === "/terms" ? <Terms /> :
    <Home />;
  return (
    <div className="page">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-panel focus:px-3 focus:py-2">Skip to content</a>
      <TopBar path={path} />
      <main id="main">{page}</main>
      <Footer />
    </div>
  );
}
