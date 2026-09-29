import { APP_ORIGIN, authClient, isWebsite, usePath } from "./lib";
import { Link } from "./ui/Link";
import { Home } from "./pages/Home";
import { Invite } from "./pages/Invite";
import { Join } from "./pages/Join";
import { Privacy, Terms } from "./pages/Legal";
import { SignIn } from "./pages/SignIn";
import { ResetPassword } from "./pages/ResetPassword";
import { Workspace } from "./pages/Workspace";

export { Link } from "./ui/Link";

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
  // The signed-in app has its own full-screen shell (sidebar, tab bar), not the website frame.
  if (path === "/app" || path.startsWith("/app/")) return <Workspace path={path} />;
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
      <TopBar path={path} />
      <main>{page}</main>
      <Footer />
    </div>
  );
}
