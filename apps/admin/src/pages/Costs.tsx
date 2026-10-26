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
  writeSpeed: { measured: number; medianMs: number; slowestTenthMs: number; fallbacks: number; recentFallbacks: { at: string; model: string; durationMs: number; reason: string }[] };
  workspaces: { orgId: string; name: string; plan: string; costUsd: number; xUsd: number; paysUsd: number; losing: boolean }[];
  xApi: { monthToDateUsd: number; last30Usd: number; posts: number; images: number; reads: number };
};

const FEATURES: Record<string, string> = { write: "Writing posts", research: "Web research", insights: "Audience insights", video_plan: "Video plans", narration: "Voice-over", image: "AI images", transcription: "Voice notes", photo: "Reading photos", relevance: "Topic checks" };
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

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
        <Stat label="X API" value={money(data.xApi.monthToDateUsd)} sub={`this month · 30 days: ${data.xApi.posts} posts, ${data.xApi.images} images, ${data.xApi.reads} reads`} info="What X charged for posts sent through the app: $0.015 a post, $0.005 per image description, $0.005 per post read from followed X accounts ($0.010 per account lookup). Uploads, the Premium check and sign-in renewals are free. Posts with a link always go by hand." />
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
      <Panel title="Writing speed" info="Last 30 days, from clicking Write to the posts being ready: the first model, any fallback and any fixes. A fallback means the first model failed or its answer was rejected; the reason is kept.">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Typical" value={data.writeSpeed.measured ? secs(data.writeSpeed.medianMs) : "–"} sub={`${data.writeSpeed.measured} writes measured`} />
          <Stat label="Slowest 10%" value={data.writeSpeed.measured ? secs(data.writeSpeed.slowestTenthMs) : "–"} sub="or slower" />
          <Stat label="Fallbacks" value={data.writeSpeed.fallbacks} sub={data.writeSpeed.measured ? `${Math.round((data.writeSpeed.fallbacks / data.writeSpeed.measured) * 100)}% of writes` : "none measured"} />
        </div>
        <Table
          rows={data.writeSpeed.recentFallbacks}
          empty="No fallbacks."
          cols={[
            { label: "When", cell: (r) => new Date(r.at).toLocaleString() },
            { label: "Answered by", cell: (r) => <span className="font-mono text-[12px]">{r.model}</span> },
            { label: "Took", cell: (r) => secs(r.durationMs), num: true },
            { label: "Why", cell: (r) => <span className="text-[12.5px] [overflow-wrap:anywhere]">{r.reason}</span> },
          ]}
        />
      </Panel>
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
