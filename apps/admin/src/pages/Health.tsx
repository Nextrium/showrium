// Publishing health: per platform, why posts fail, accounts to reconnect, stuck or overdue posts, and the background jobs.
import { Alert, Loading, Panel, Tag, useLoad } from "../ui";
import { ago, Stat, Table } from "./parts";

type Data = {
  platforms: { platform: string; published7: number; failed7: number; published30: number; failed30: number; failRate30: number }[];
  reasons: { reason: string; platform: string; count: number }[];
  reconnect: { orgId: string; orgName: string; platform: string; handle: string; since: string }[];
  stuck: { id: string; orgId: string; platform: string; since: string }[];
  overdue: { id: string; orgId: string; platform: string; due: string | null }[];
  jobs: { posting: { lastPublishedAt: string | null; behind: boolean }; automation: { lastRunAt: string | null }; sources: { lastCheckedAt: string | null; late: boolean } };
};

const NAMES: Record<string, string> = { x: "X", linkedin: "LinkedIn", bluesky: "Bluesky", mastodon: "Mastodon", threads: "Threads", facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube_shorts: "YouTube Shorts" };

export function Health() {
  const { data, error } = useLoad<Data>("/health");
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  const j = data.jobs;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Posting" value={j.posting.behind ? "Behind" : "OK"} tone={j.posting.behind ? "danger" : "ok"} sub={`last sent ${ago(j.posting.lastPublishedAt)}`} info="Behind: scheduled posts are more than 15 minutes overdue (the posting job isn't keeping up, or the workspace is paused)." />
        <Stat label="Automation" value={ago(j.automation.lastRunAt)} sub="last run" />
        <Stat label="Sources" value={j.sources.late ? "Late" : "OK"} tone={j.sources.late ? "warn" : "ok"} sub={`last checked ${ago(j.sources.lastCheckedAt)}`} info="Late: no source checked in 6 hours." />
        <Stat label="To reconnect" value={data.reconnect.length} tone={data.reconnect.length ? "warn" : undefined} sub="accounts" />
      </div>
      <Panel title="By platform" info="Posts published or failed. Fail rate: last 30 days.">
        <Table
          rows={data.platforms}
          empty="No posts published or failed in 30 days."
          cols={[
            { label: "Platform", cell: (r) => NAMES[r.platform] ?? r.platform },
            { label: "Published 7d", cell: (r) => r.published7, num: true },
            { label: "Failed 7d", cell: (r) => r.failed7, num: true },
            { label: "Published 30d", cell: (r) => r.published30, num: true },
            { label: "Failed 30d", cell: (r) => r.failed30, num: true },
            { label: "Fail rate", cell: (r) => <Tag tone={r.failRate30 >= 20 ? "danger" : r.failRate30 >= 5 ? "warn" : "ok"}>{r.failRate30}%</Tag>, num: true },
          ]}
        />
      </Panel>
      <Panel title="Why posts fail" info="The platforms' own reasons, last 30 days. Similar messages are counted together.">
        <Table rows={data.reasons} empty="No failures in 30 days." cols={[{ label: "Platform", cell: (r) => NAMES[r.platform] ?? r.platform }, { label: "Reason", cell: (r) => r.reason }, { label: "Posts", cell: (r) => r.count, num: true }]} />
      </Panel>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Accounts to reconnect">
          <Table rows={data.reconnect} empty="None." cols={[{ label: "Workspace", cell: (r) => r.orgName }, { label: "Account", cell: (r) => `${NAMES[r.platform] ?? r.platform} ${r.handle}` }, { label: "Since", cell: (r) => ago(r.since), num: true }]} />
        </Panel>
        <Panel title="Stuck or overdue" info="Stuck: posting for more than 15 minutes (recovered automatically). Overdue: scheduled time passed by more than 15 minutes.">
          <Table
            rows={[...data.stuck.map((s) => ({ kind: "Stuck", platform: s.platform, when: s.since })), ...data.overdue.map((o) => ({ kind: "Overdue", platform: o.platform, when: o.due }))]}
            empty="None."
            cols={[{ label: "", cell: (r) => <Tag tone={r.kind === "Stuck" ? "danger" : "warn"}>{r.kind}</Tag> }, { label: "Platform", cell: (r) => NAMES[r.platform] ?? r.platform }, { label: "Since", cell: (r) => ago(r.when), num: true }]}
          />
        </Panel>
      </div>
    </>
  );
}
