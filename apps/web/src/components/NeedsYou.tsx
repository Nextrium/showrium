// Time-sensitive posts automation couldn't fit in time: a banner that takes the person to them.
import { useApi } from "../lib";
import { Info, Icon, LinkButton } from "../ui/kit";

export function NeedsYouBanner() {
  const { data } = useApi<{ needsYou: number }>("/summary");
  const n = data?.needsYou ?? 0;
  if (!n) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-warn/50 bg-warn-soft px-4 py-3" role="status">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-panel text-warn"><Icon name="alert" size={17} /></span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[14.5px] text-ink">
        {n === 1 ? "A time-sensitive post needs you" : `${n} time-sensitive posts need you`}
        <Info label="About time-sensitive posts">Fresh news worth posting soon, but today's automated posts are already used. Post it now, post it yourself, pick a time today, or skip it.</Info>
      </span>
      <LinkButton to="/app/posts?needs=1" size="sm">{n === 1 ? "See it" : "See them"}</LinkButton>
    </div>
  );
}
