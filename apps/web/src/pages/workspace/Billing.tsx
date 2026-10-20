import { BillingCard } from "../../components/BusinessCards";
import { formatDate, useApi } from "../../lib";
import { Info, Meter, PageHeader, Panel } from "../../ui/kit";

type Me = { principal: { role: string } };
type Credits = { balance: number; transactions: { id: string; kind: string; description: string; amount: number; createdAt: string }[] };
type Costs = { totalUsd: number; ai: { usd: number; byFeature: { feature: string; usd: number; calls: number; estimated: boolean }[] }; x: { usd: number; posts: number; images: number } };
type Usage = { posts: { used: number; limit: number }; videos: { used: number; limit: number }; sources: { limit: number } };

export function BillingPage() {
  const { data: me } = useApi<Me>("/me");
  const { data: credits } = useApi<Credits>("/credits");
  const { data: usage } = useApi<Usage>("/usage");
  const { data: costs } = useApi<Costs>("/costs");
  const canManage = me?.principal.role === "owner" || me?.principal.role === "admin";
  return (
    <>
      <PageHeader title="Billing and usage" actions={<Info label="About plans">Every plan gets the same quality. Plans change how much you can do, and what can run for you.</Info>} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-5">
          <BillingCard canManage={canManage} />
          {usage && (
            <Panel title="This month" id="usage">
              <div className="grid gap-4 sm:grid-cols-2">
                <Meter label="AI posts" value={usage.posts.used} max={usage.posts.limit} />
                <Meter label="Videos" value={usage.videos.used} max={usage.videos.limit} />
              </div>
              <span className="text-sm text-muted">Sources you can connect: {usage.sources.limit}.</span>
            </Panel>
          )}
          {costs && <CostsPanel costs={costs} />}
        </div>
        <Panel title="Credits" id="credits">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-4xl font-semibold">{credits?.balance ?? "–"}</span>
            <span className="text-sm text-muted">1 credit = $0.01 · never expire</span>
          </div>
          <p className="m-0 text-sm text-muted">Used only past your plan. X posts through the app: 2 credits, plus 1 for each image after the first.</p>
          <div className="table-wrap">
            <table>
              <tbody>
                {credits?.transactions.map((t) => (
                  <tr key={t.id}>
                    <td>{t.description}</td>
                    <td className="text-muted">{formatDate(t.createdAt)}</td>
                    <td className={`num ${t.amount > 0 ? "plus" : ""}`}>{t.amount > 0 ? `+${t.amount}` : t.amount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </>
  );
}

const FEATURES: Record<string, string> = { write: "Writing posts", research: "Web research", insights: "Audience insights", video_plan: "Video plans", narration: "Voice-over", image: "AI images", transcription: "Voice notes", photo: "Reading photos" };
const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/** What this workspace's use has cost Showrium this month, for transparency (our costs, not charges). */
function CostsPanel({ costs }: { costs: Costs }) {
  const rows = [
    ...costs.ai.byFeature.map((f) => ({ key: f.feature, label: FEATURES[f.feature] ?? f.feature, detail: `${f.calls} AI ${f.calls === 1 ? "call" : "calls"}${f.estimated ? ", estimated" : ""}`, usd: f.usd })),
    ...(costs.x.posts || costs.x.images ? [{ key: "x", label: "X API", detail: `${costs.x.posts} ${costs.x.posts === 1 ? "post" : "posts"}${costs.x.images ? `, ${costs.x.images} image ${costs.x.images === 1 ? "description" : "descriptions"}` : ""}`, usd: costs.x.usd }] : []),
  ];
  return (
    <Panel
      id="costs"
      title={
        <span className="inline-flex items-center gap-1.5">
          What your use costs us
          <Info label="About these costs">What Showrium paid AI providers and X for your workspace this month. These are our costs, not charges to you. Some AI costs (images, voice) are estimates, as that provider doesn't report a price. X charges $0.015 a post and $0.005 per image description.</Info>
        </span>
      }
    >
      <div className="flex items-baseline gap-2">
        <span className="font-display text-3xl font-semibold">{usd(costs.totalUsd)}</span>
        <span className="text-sm text-muted">this month</span>
      </div>
      {rows.length === 0 ? (
        <span className="text-sm text-muted">Nothing yet this month.</span>
      ) : (
        <div className="table-wrap">
          <table>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td className="text-muted">{r.detail}</td>
                  <td className="num">{usd(r.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
