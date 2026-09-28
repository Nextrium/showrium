import { authClient, useRedirect } from "../lib";
import { AppShell } from "../shell/AppShell";
import { Loading } from "../ui/kit";
import { AuditPage } from "./workspace/Audit";
import { AutomationPage } from "./workspace/Automation";
import { BillingPage } from "./workspace/Billing";
import { ConnectionsPage } from "./workspace/Connections";
import { CreatePage } from "./workspace/Create";
import { DraftsPage } from "./workspace/Drafts";
import { AppHome } from "./workspace/Home";
import { IdeasPage, InsightsPage } from "./workspace/Insights";
import { SettingsPage } from "./workspace/Settings";
import { SourcesPage } from "./workspace/Sources";
import { StudioPage } from "./workspace/Studio";
import { TeamPage } from "./workspace/Team";
import { VoicePage } from "./workspace/Voice";

const PAGES: Record<string, () => React.ReactNode> = {
  "/app": () => <AppHome />,
  "/app/new": () => <CreatePage />,
  "/app/posts": () => <DraftsPage />,
  "/app/drafts": () => <DraftsPage />, // old address
  "/app/ideas": () => <IdeasPage />,
  "/app/studio": () => <StudioPage />,
  "/app/insights": () => <InsightsPage />,
  "/app/sources": () => <SourcesPage />,
  "/app/accounts": () => <ConnectionsPage />,
  "/app/voice": () => <VoicePage />,
  "/app/automation": () => <AutomationPage />,
  "/app/team": () => <TeamPage />,
  "/app/billing": () => <BillingPage />,
  "/app/settings": () => <SettingsPage />,
  "/app/audit": () => <AuditPage />,
};

export function Workspace({ path }: { path: string }) {
  const { data: session, isPending } = authClient.useSession();
  const signedOut = !isPending && !session;
  useRedirect("/signin", signedOut);
  if (signedOut) return null;
  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Loading label="Opening your workspace…" />
      </div>
    );
  }
  const page = PAGES[path.replace(/\/$/, "") || "/app"] ?? PAGES["/app"]!;
  return <AppShell path={path}>{page()}</AppShell>;
}
