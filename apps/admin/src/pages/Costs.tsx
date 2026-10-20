// AI costs: what every AI call costs us, by day, feature and model, per post, and per workspace against what it pays.
import { Alert, Loading, Panel, PLAN_NAMES, Tag, useLoad } from "../ui";
import { DayBars, money, Stat, Table } from "./parts";

type Group = { name: string; usd: number; calls: number };
type Data = {
  monthToDateUsd: number;
  last30Usd: number;
  estimatedShare: number;
  byDay: { date: string; usd: number }[];
  byFeature: Group[];
  byModel: Group[];
  perPost: { posts: number; usd: number };
  workspaces: { orgId: string; name: string; plan: string; costUsd: number; xUsd: number; paysUsd: number; losing: boolean }[];
  xApi: { monthToDateUsd: number; last30Usd: number; posts: number; images: number };
};

const FEATURES: Record<string, string> = { write: "Writing posts", research: "Web research", insights: "Audience insights", video_plan: "Video plans", narration: "Voice-over", image: "AI images", transcription: "Voice notes", photo: "Reading photos" };

export function Costs() {
  const { data, error } = useLoad<Data>("/costs");
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="This month" value={money(data.monthToDateUsd)} sub="AI, all features" />
        <Stat label="Last 30 days" value={money(data.last30Usd)} sub={`${data.estimatedShare}% estimated`} info="Images, voice notes, photos and voice-overs run on Cloudflare Workers AI, which doesn't report a price: those are estimates from Cloudflare's published rates." />
        <Stat label="Per post" value={money(data.perPost.usd)} sub={`${data.perPost.posts} posts in 30 days`} info="Writing and research cost, divided by the posts written." />
        <Stat label="X API" value={money(data.xApi.monthToDateUsd)} sub={`this month · ${data.xApi.posts} posts, ${data.xApi.images} images in 30 days`} info="What X charged for posts sent through the app: $0.015 a post and $0.005 per image description. Uploads, the Premium check and sign-in renewals are free. Posts with a link always go by hand." />
      </div>
      <Panel title="Daily cost">
        <DayBars title="AI cost" days={data.byDay.map((d) => ({ date: d.date, value: d.usd }))} format={money} />
      </Panel>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="By feature" info="Last 30 days.">
          <Table rows={data.byFeature} cols={[{ label: "Feature", cell: (r) => FEATURES[r.name] ?? r.name }, { label: "Calls", cell: (r) => r.calls, num: true }, { label: "Cost", cell: (r) => money(r.usd), num: true }]} />
        </Panel>
        <Panel title="By model" info="Last 30 days.">
          <Table rows={data.byModel} cols={[{ label: "Model", cell: (r) => <span className="font-mono text-[12px]">{r.name}</span> }, { label: "Calls", cell: (r) => r.calls, num: true }, { label: "Cost", cell: (r) => money(r.usd), num: true }]} />
        </Panel>
      </div>
      <Panel title="Workspaces that cost most" info="AI and X costs in the last 30 days against what the workspace pays a month (yearly plans divided by 12). Losing: costs more than it pays (for a workspace that pays nothing, over $1 in 30 days).">
        <Table
          rows={data.workspaces}
          empty="No AI use in the last 30 days."
          cols={[
            { label: "Workspace", cell: (r) => r.name },
            { label: "Plan", cell: (r) => PLAN_NAMES[r.plan] ?? r.plan },
            { label: "Cost", cell: (r) => money(r.costUsd), num: true },
            { label: "of which X", cell: (r) => money(r.xUsd), num: true },
            { label: "Pays", cell: (r) => money(r.paysUsd), num: true },
            { label: "", cell: (r) => (r.losing ? <Tag tone="danger">Losing</Tag> : null) },
          ]}
        />
      </Panel>
    </>
  );
}
