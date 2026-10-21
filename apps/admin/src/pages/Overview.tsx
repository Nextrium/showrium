import { useState } from "react";
import { Alert, Button, Info, Loading, Panel, PLAN_NAMES, useLoad } from "../ui";
import { navigateTo } from "../App";

type Day = { date: string; signups: number; written: number; published: number };
type Data = {
  users: { total: number; last30Days: number };
  posts: { written30Days: number; published30Days: number; failed30Days: number };
  plans: { plan: string; workspaces: number }[];
  subscriptions: Record<string, number>;
  kinds: { paying: number; granted: number; full_access: number; free: number };
  aiCostThisMonthUsd: number;
  waitlist: { waiting: number; invited: number; joined: number };
  daily: Day[];
};

function Stat({ label, value, sub, info }: { label: string; value: string | number; sub?: string; info?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-line bg-panel p-4">
      <span className="flex items-center gap-1.5 text-[13px] text-muted">
        {label} {info && <Info>{info}</Info>}
      </span>
      <span className="font-display text-[28px] font-semibold leading-none">{value}</span>
      {sub && <span className="text-[12.5px] text-muted">{sub}</span>}
    </div>
  );
}

/** One measure over 14 days: thin bars from the baseline, a tooltip per bar. */
function Bars({ title, days, k }: { title: string; days: Day[]; k: "signups" | "written" | "published" }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d[k]));
  const total = days.reduce((a, d) => a + d[k], 0);
  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium text-ink-2">{title}</span>
        <span className="text-muted">{total} in 14 days</span>
      </figcaption>
      <div className="relative flex h-24 items-end gap-[2px] border-b border-line" role="img" aria-label={`${title}: ${total} in the last 14 days`}>
        {days.map((d, i) => (
          <div
            key={d.date}
            className="flex h-full flex-1 cursor-default items-end"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div className={`w-full rounded-t-[4px] ${hover === i ? "bg-accent-ink" : "bg-accent"}`} style={{ height: `${d[k] ? Math.max(4, (d[k] / max) * 100) : 0}%` }} />
          </div>
        ))}
        {hover !== null && (
          <div className="pointer-events-none absolute -top-8 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink shadow-[var(--shadow)]" style={{ left: `min(calc(${(hover / days.length) * 100}%), calc(100% - 7rem))` }}>
            {new Date(days[hover]!.date).toLocaleDateString(undefined, { day: "numeric", month: "short" })}: <strong>{days[hover]![k]}</strong>
          </div>
        )}
      </div>
    </figure>
  );
}

export function Overview() {
  const { data, error } = useLoad<Data>("/overview");
  const [table, setTable] = useState(false);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Users" value={data.users.total} sub={`+${data.users.last30Days} in 30 days`} />
        <Stat label="Posts written" value={data.posts.written30Days} sub="last 30 days" />
        <Stat label="Published" value={data.posts.published30Days} sub={`${data.posts.failed30Days} failed`} info="Posts published through the platforms' APIs or marked as posted by hand, in the last 30 days." />
        <Stat label="AI cost" value={`$${data.aiCostThisMonthUsd.toFixed(2)}`} sub="this month" info="Every AI call this month: posts, research, insights, images, video and voice (some are estimates; see AI costs)." />
        <Stat label="Waiting" value={data.waitlist.waiting} sub={`${data.waitlist.invited} invited · ${data.waitlist.joined} joined`} />
        <Stat label="Paying" value={data.kinds.paying} sub={`${data.kinds.granted} granted · ${data.kinds.full_access} full access`} info="Paying: workspaces with a subscription still in force. Granted plans and full access are given by staff and bring no revenue." />
      </div>
      <Panel title="Last 14 days" actions={<Button variant="ghost" onClick={() => setTable((t) => !t)}>{table ? "Show charts" : "Show table"}</Button>}>
        {table ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 font-medium">Day</th>
                  <th className="py-1 text-right font-medium">Sign-ups</th>
                  <th className="py-1 text-right font-medium">Written</th>
                  <th className="py-1 text-right font-medium">Published</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((d) => (
                  <tr key={d.date} className="border-t border-line">
                    <td className="py-1">{d.date}</td>
                    <td className="py-1 text-right font-mono">{d.signups}</td>
                    <td className="py-1 text-right font-mono">{d.written}</td>
                    <td className="py-1 text-right font-mono">{d.published}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-3">
            <Bars title="Sign-ups" days={data.daily} k="signups" />
            <Bars title="Posts written" days={data.daily} k="written" />
            <Bars title="Published" days={data.daily} k="published" />
          </div>
        )}
      </Panel>
      <Panel title="Workspaces by access" info="Paying: a subscription still in force (active, late on a payment, or cancelled but inside its paid period). Granted plan: a plan above Free given by staff, with no paying subscription. Full access: given by staff. Open a group in Users.">
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {([["paying", "Paying"], ["granted", "Granted plan"], ["full_access", "Full access"], ["free", "Free"]] as const).map(([k, label]) => (
            <li key={k}>
              <button type="button" onClick={() => navigateTo(`/users?kind=${k}`)} className="cursor-pointer rounded-lg border-0 bg-raised px-3 py-1.5 text-[13.5px] text-ink hover:bg-[var(--selected)]">
                {label}: <strong>{data.kinds[k]}</strong>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Workspaces by plan">
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {data.plans.map((p) => (
            <li key={p.plan} className="rounded-lg bg-raised px-3 py-1.5 text-[13.5px]">
              {PLAN_NAMES[p.plan] ?? p.plan}: <strong>{p.workspaces}</strong>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
