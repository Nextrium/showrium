import { Link } from "../App";
import { authClient, currentOrgId, switchWorkspace, useApi, useRedirect } from "../lib";
import { CreatePage } from "./workspace/Create";
import { DraftsPage } from "./workspace/Drafts";
import { SourcesPage } from "./workspace/Sources";
import { VoicePage } from "./workspace/Voice";
import { Dashboard } from "./Dashboard";
import { ConnectionsPage } from "./workspace/Connections";
import { StudioPage } from "./workspace/Studio";
import { InsightsPage } from "./workspace/Insights";

const TABS = [
  { path: "/app", label: "Create" },
  { path: "/app/drafts", label: "Drafts" },
  { path: "/app/studio", label: "Video" },
  { path: "/app/sources", label: "Sources" },
  { path: "/app/accounts", label: "Accounts" },
  { path: "/app/insights", label: "Insights" },
  { path: "/app/voice", label: "Voice" },
  { path: "/app/settings", label: "Settings" },
];

function WorkspaceSwitcher() {
  const { data } = useApi<{ data: { id: string; name: string; role: string }[] }>("/workspaces");
  if (!data || data.data.length < 2) return null;
  const current = currentOrgId() ?? data.data[0]!.id;
  return (
    <label className="switcher">
      Workspace
      <select value={current} onChange={(e) => switchWorkspace(e.target.value)}>
        {data.data.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.role})</option>)}
      </select>
    </label>
  );
}

export function Workspace({ path }: { path: string }) {
  const { data: session, isPending } = authClient.useSession();
  const signedOut = !isPending && !session;
  useRedirect("/signin", signedOut);
  if (signedOut) return null;
  if (isPending) return <p className="note">Loading…</p>;

  const page =
    path === "/app/drafts" ? <DraftsPage /> :
    path === "/app/studio" ? <StudioPage /> :
    path === "/app/sources" ? <SourcesPage /> :
    path === "/app/accounts" ? <ConnectionsPage /> :
    path === "/app/insights" ? <InsightsPage /> :
    path === "/app/voice" ? <VoicePage /> :
    path === "/app/settings" ? <Dashboard /> :
    <CreatePage />;

  return (
    <div className="dash">
      <WorkspaceSwitcher />
      <nav className="tabs" aria-label="Workspace">
        {TABS.map((t) => (
          <Link key={t.path} to={t.path} className={`tab${path === t.path ? " active" : ""}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {page}
    </div>
  );
}
