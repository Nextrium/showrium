// Abuse: workspaces worth a look (signals, not verdicts), and Pause/Resume (owners only, reversible, logged).
import { useState } from "react";
import type { Me } from "../App";
import { Alert, api, Button, date, Loading, Panel, Tag, useLoad } from "../ui";
import { Table } from "./parts";

type Data = {
  workspaces: { orgId: string; name: string; reasons: string[]; pausedAt: string | null; pausedReason: string | null }[];
  busyIps: { ip: string; accounts: number }[];
  paused: { orgId: string; name: string; pausedAt: string; pausedReason: string | null; pausedBy: string | null }[];
};

/** Pause with a reason, or Resume. Owners only (the server checks too). */
function PauseControl({ orgId, paused, onDone }: { orgId: string; paused: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/workspaces/${orgId}/${path}`, { method: "POST", body: JSON.stringify(body) });
      setOpen(false);
      setReason("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  if (paused) {
    return (
      <span className="flex flex-col items-end gap-1">
        <Button disabled={busy} onClick={() => void act("resume", {})}>{busy ? "Resuming…" : "Resume"}</Button>
        {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
      </span>
    );
  }
  return open ? (
    <form className="flex w-full flex-col gap-2 sm:w-80" onSubmit={(e) => { e.preventDefault(); void act("pause", { reason }); }}>
      <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={300} required placeholder="Reason (kept in the admin log)" className="min-h-9 rounded-lg border border-line-strong bg-panel px-3 text-[14px] text-ink" autoFocus />
      <span className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || reason.trim().length < 5}>{busy ? "Pausing…" : "Pause"}</Button>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
      </span>
      {error && <span role="alert" className="text-[12px] text-danger">{error}</span>}
    </form>
  ) : (
    <Button onClick={() => setOpen(true)}>Pause</Button>
  );
}

export function Abuse({ me }: { me: Me }) {
  const { data, error, reload } = useLoad<Data>("/abuse");
  const canPause = me.permissions.includes("abuse.pause");
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  return (
    <>
      <Panel
        title="Worth a look"
        info="From signals we already have, no AI: many failed or refused posts, posts flagged for team wording or unverified facts, or AI spend far above what the workspace pays. Signals, not verdicts. Pause stops automation and publishing, and nothing is deleted."
      >
        {data.workspaces.length === 0 && <p className="m-0 text-[13.5px] text-muted">Nothing worth a look right now.</p>}
        <ul className="m-0 flex list-none flex-col p-0">
          {data.workspaces.map((w) => (
            <li key={w.orgId} className="flex flex-wrap items-start gap-3 border-b border-line py-3 last:border-b-0">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex items-center gap-2 font-medium">
                  {w.name} {w.pausedAt && <Tag tone="warn">Paused</Tag>}
                </span>
                {w.reasons.map((r) => (
                  <span key={r} className="text-[13px] text-ink-2">• {r}</span>
                ))}
              </div>
              {canPause && <PauseControl orgId={w.orgId} paused={Boolean(w.pausedAt)} onDone={reload} />}
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Paused workspaces">
        <Table
          rows={data.paused}
          empty="None."
          cols={[
            { label: "Workspace", cell: (r) => r.name },
            { label: "Reason", cell: (r) => r.pausedReason ?? "" },
            { label: "By", cell: (r) => r.pausedBy ?? "" },
            { label: "Since", cell: (r) => date(r.pausedAt) },
            { label: "", cell: (r) => (canPause ? <PauseControl orgId={r.orgId} paused onDone={reload} /> : null) },
          ]}
        />
      </Panel>
      <Panel title="New accounts from one address" info="Three or more accounts made from the same IP address in the last week (the address is partly hidden). Can be a shared office or a school.">
        <Table rows={data.busyIps} empty="None." cols={[{ label: "Address", cell: (r) => <span className="font-mono text-[12px]">{r.ip}</span> }, { label: "Accounts", cell: (r) => r.accounts, num: true }]} />
      </Panel>
    </>
  );
}
