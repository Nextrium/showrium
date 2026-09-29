import { BillingCard } from "../../components/BusinessCards";
import { formatDate, useApi } from "../../lib";
import { Meter, PageHeader, Panel } from "../../ui/kit";

type Me = { principal: { role: string } };
type Credits = { balance: number; transactions: { id: string; kind: string; description: string; amount: number; createdAt: string }[] };
type Usage = { posts: { used: number; limit: number }; videos: { used: number; limit: number }; sources: { limit: number } };

export function BillingPage() {
  const { data: me } = useApi<Me>("/me");
  const { data: credits } = useApi<Credits>("/credits");
  const { data: usage } = useApi<Usage>("/usage");
  const canManage = me?.principal.role === "owner" || me?.principal.role === "admin";
  return (
    <>
      <PageHeader title="Billing and usage" subtitle="Every plan gets the same quality. Plans change how much you can do, and what can run for you." />
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
        </div>
        <Panel title="Credits" id="credits">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-4xl font-semibold">{credits?.balance ?? "–"}</span>
            <span className="text-sm text-muted">1 credit = $0.01 · never expire</span>
          </div>
          <p className="m-0 text-sm text-muted">Used only past your plan, or for extras like X posts with links.</p>
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
