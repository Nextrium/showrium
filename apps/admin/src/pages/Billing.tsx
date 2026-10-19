// Billing: paying workspaces, monthly revenue, past-due follow-ups, payment events and credits. Read-only:
// refunds and plan changes happen in the payment provider's dashboard.
import { Alert, date, Loading, Panel, PLAN_NAMES, Tag, useLoad } from "../ui";
import { ago, money, Stat, Table } from "./parts";

type Sub = { orgId: string; orgName: string; provider: string; plan: string; interval: string; seats: number | null; status: string; renews: string | null; monthlyUsd: number };
type Data = {
  mrrUsd: number;
  counts: Record<string, number>;
  subscriptions: Sub[];
  pastDue: Sub[];
  events: { provider: string; type: string; outcome: string; orgId: string | null; at: string }[];
  eventProblems: number;
  credits: { purchased: number; granted: number; spent: number; refunded: number; outstanding: number };
};

const PROBLEMS = ["amount_mismatch", "unknown_item", "unknown_subscription", "not_paid", "ignored_unsigned"];
const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = { active: "ok", past_due: "warn", cancelled: "neutral", expired: "neutral" };

export function Billing() {
  const { data, error } = useLoad<Data>("/billing");
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  const subCols = [
    { label: "Workspace", cell: (r: Sub) => r.orgName },
    { label: "Plan", cell: (r: Sub) => `${PLAN_NAMES[r.plan] ?? r.plan}${r.seats ? ` × ${r.seats}` : ""} · ${r.interval === "year" ? "yearly" : "monthly"}` },
    { label: "Status", cell: (r: Sub) => <Tag tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status.replace("_", " ")}</Tag> },
    { label: "Renews", cell: (r: Sub) => date(r.renews) },
    { label: "A month", cell: (r: Sub) => money(r.monthlyUsd), num: true },
    { label: "Via", cell: (r: Sub) => r.provider },
  ];
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Monthly revenue" value={money(data.mrrUsd)} info="Active and past-due subscriptions, yearly plans divided by 12, before payment fees." />
        <Stat label="Active" value={data.counts.active ?? 0} tone="ok" />
        <Stat label="Past due" value={data.counts.past_due ?? 0} tone={data.counts.past_due ? "warn" : undefined} info="The payment failed and the provider is retrying. Worth a friendly email." />
        <Stat label="Payment problems" value={data.eventProblems} tone={data.eventProblems ? "danger" : undefined} sub="in the last 50 events" info="Wrong amount, unknown item or subscription, unpaid, or an unsigned (possibly forged) notice." />
      </div>
      {data.pastDue.length > 0 && (
        <Panel title="Past due">
          <Table rows={data.pastDue} cols={subCols} />
        </Panel>
      )}
      <Panel title="Subscriptions" info="Refunds and plan changes are made in the payment provider's dashboard.">
        <Table rows={data.subscriptions} empty="No subscriptions yet." cols={subCols} />
      </Panel>
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Payment events" info="The latest 50 notices from the payment providers, and what we did with each.">
          <Table
            rows={data.events}
            empty="None yet."
            cols={[
              { label: "When", cell: (r) => ago(r.at) },
              { label: "Event", cell: (r) => <span className="font-mono text-[12px]">{r.provider} · {r.type}</span> },
              { label: "Outcome", cell: (r) => <Tag tone={PROBLEMS.includes(r.outcome) ? "danger" : "neutral"}>{r.outcome.replace(/_/g, " ")}</Tag> },
            ]}
          />
        </Panel>
        <Panel title="Credits" info="Across all workspaces, in credits.">
          <Table
            rows={[
              { k: "Bought", v: data.credits.purchased },
              { k: "Granted", v: data.credits.granted },
              { k: "Spent", v: data.credits.spent },
              { k: "Refunded", v: data.credits.refunded },
              { k: "On balances now", v: data.credits.outstanding },
            ]}
            cols={[{ label: "", cell: (r) => r.k }, { label: "Credits", cell: (r) => r.v.toLocaleString(), num: true }]}
          />
        </Panel>
      </div>
    </>
  );
}
