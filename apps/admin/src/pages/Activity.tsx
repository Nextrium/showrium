import { Alert, Loading, Panel, useLoad } from "../ui";

type Entry = { id: string; actorEmail: string; action: string; target: string | null; meta: Record<string, unknown> | null; createdAt: string };

const ACTIONS: Record<string, string> = {
  "waitlist.invited": "Invited from waitlist",
  "user.viewed": "Opened an account",
  "workspace.plan_changed": "Changed a plan",
  "workspace.access_granted": "Gave full access",
  "workspace.access_removed": "Removed full access",
  "staff.invited": "Invited staff",
  "staff.removed": "Removed staff",
  "staff.role_changed": "Changed a staff role",
};

export function Activity() {
  const { data, error } = useLoad<{ data: Entry[] }>("/audit");
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  return (
    <Panel title="Admin activity" info="Everything done in the admin app, newest first. Entries can't be edited or deleted here.">
      {data.data.length === 0 && <p className="m-0 text-[13.5px] text-muted">Nothing yet.</p>}
      <ul className="m-0 flex list-none flex-col p-0">
        {data.data.map((e) => (
          <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line py-2 text-[13.5px] last:border-b-0">
            <span className="font-medium">{ACTIONS[e.action] ?? e.action}</span>
            {e.target && <span className="min-w-0 text-ink-2 [overflow-wrap:anywhere]">{e.target}</span>}
            {e.meta && typeof e.meta.note === "string" && <span className="text-muted">“{e.meta.note}”</span>}
            <span className="ml-auto text-[12.5px] text-muted">
              {e.actorEmail} · {new Date(e.createdAt).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
