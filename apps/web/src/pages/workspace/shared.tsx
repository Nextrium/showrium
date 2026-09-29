import { useApi } from "../../lib";

export type Platform = "linkedin" | "x" | "instagram" | "facebook" | "threads" | "bluesky" | "mastodon" | "tiktok" | "youtube_shorts";
export type PlatformInfo = { id: Platform; label: string; maxLength: number; publishPath: "api" | "tap_to_post" | "draft_inbox"; requiresMedia: string };
export type Issue = { code: string; severity: "error" | "warn"; message: string };
export type Draft = {
  id: string;
  briefId: string | null;
  platform: Platform;
  text: string;
  status: string;
  issues: Issue[];
  scheduledAt: string | null;
  publishedAt: string | null;
  externalUrl: string | null;
  lastError: string | null;
  createdAt: string;
  parts?: string[] | null;
  partsPosted?: number;
  source?: { mode: string; kind: string | null; title: string | null; url: string | null; contextItemId: string | null } | null;
};
export type Persona = {
  displayName: string;
  role: string;
  expertise: string[];
  interests: string[];
  audience: string;
  voice: string;
  avoid: string[];
  blockers: string[];
  platforms: Platform[];
  monetizationSafe: boolean;
};

export function usePlatforms() {
  const { data } = useApi<{ data: PlatformInfo[] }>("/platforms");
  return data?.data ?? [];
}

export const MODES = [
  { id: "build_in_public", label: "Build in public", hint: "What you shipped and why it matters" },
  { id: "teach", label: "Teach", hint: "Explain one idea clearly" },
  { id: "expert_take", label: "Expert take", hint: "Your opinion, with reasons" },
  { id: "smile", label: "Smile", hint: "Something light or funny" },
  { id: "promote", label: "Promote", hint: "An offer, clearly and honestly" },
] as const;

export function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="issues">
      {issues.map((i, n) => (
        <li key={n} className={i.severity === "error" ? "error" : "note"}>
          {i.severity === "error" ? "Must fix: " : "Check: "}
          {i.message}
        </li>
      ))}
    </ul>
  );
}
