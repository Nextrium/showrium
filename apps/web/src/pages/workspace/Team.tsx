import { TeamCard } from "../../components/BusinessCards";
import { authClient, useApi } from "../../lib";
import { Info, PageHeader } from "../../ui/kit";

type Me = { principal: { role: string } };

export function TeamPage() {
  const { data: me } = useApi<Me>("/me");
  const { data: session } = authClient.useSession();
  const canManage = me?.principal.role === "owner" || me?.principal.role === "admin";
  return (
    <>
      <PageHeader title="Team" actions={<Info label="About the team">Invite people by email and choose what each person can do.</Info>} />
      <div className="max-w-3xl">
        <TeamCard canManage={canManage} myEmail={session?.user.email ?? ""} />
      </div>
    </>
  );
}
