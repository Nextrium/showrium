import { AuditCard } from "../../components/BusinessCards";
import { useApi } from "../../lib";
import { Alert, Info, PageHeader } from "../../ui/kit";

type Me = { principal: { role: string } };

export function AuditPage() {
  const { data: me } = useApi<Me>("/me");
  const canManage = me?.principal.role === "owner" || me?.principal.role === "admin";
  return (
    <>
      <PageHeader title="Audit log" actions={<Info label="About the audit log">Who did what in this workspace, newest first.</Info>} />
      {me && !canManage ? <Alert tone="info">Only workspace owners and admins can read the audit log.</Alert> : <AuditCard />}
    </>
  );
}
