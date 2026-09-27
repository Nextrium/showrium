// Access rules as pure functions, so the account-state matrix can be tested exhaustively.
import type { Role } from "@nextrium/db";

/**
 * Beta sign-up allowlist. Entries are comma-separated: full emails ("ada@example.com"),
 * whole domains ("@nextrium.com"), or "*" to allow everyone.
 * An empty or missing list allows nobody (fail closed).
 */
export function isEmailAllowed(email: string, allowlist: string | undefined): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;
  const entries = (allowlist ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return entries.some((entry) =>
    entry === "*" ? true : entry.startsWith("@") ? normalized.endsWith(entry) : normalized === entry,
  );
}

export type PrincipalKind = "user" | "api_key";

/** Only owners and admins signed in to the app may create or revoke API keys. API keys never can. */
export function canManageApiKeys(kind: PrincipalKind, role: Role | string): boolean {
  return kind === "user" && (role === "owner" || role === "admin");
}
