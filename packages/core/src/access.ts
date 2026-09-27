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

export type SignupMode = "waitlist" | "allowlist";

/** Reads the configured sign-up mode. Anything unexpected means "waitlist" (fail closed). */
export function parseSignupMode(value: string | undefined): SignupMode {
  return value === "allowlist" ? "allowlist" : "waitlist";
}

/**
 * Whether a new account may be created. Waitlist mode: nobody (people join the waitlist and get invited).
 * Allowlist mode: only emails on the allowlist.
 */
export function canSignUp(mode: SignupMode, email: string, allowlist: string | undefined): boolean {
  return mode === "allowlist" && isEmailAllowed(email, allowlist);
}

/**
 * Platform admins (Nextrium staff) can create invites. Exact emails only: no wildcards
 * and no domains, so a misconfiguration can't make everyone an admin. Unset = nobody.
 */
export function isPlatformAdmin(email: string | null | undefined, adminList: string | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  const admins = (adminList ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@") && !e.startsWith("@") && e !== "*");
  return admins.includes(normalized);
}

/** Reads one cookie from a Cookie header without a parsing library. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Workspace permissions by role. API keys act with the admin role (they can't manage keys, see above). */
export type Permission = "content.read" | "content.write" | "draft.approve" | "publish" | "workspace.manage";
const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: ["content.read", "content.write", "draft.approve", "publish", "workspace.manage"],
  admin: ["content.read", "content.write", "draft.approve", "publish", "workspace.manage"],
  editor: ["content.read", "content.write"],
  approver: ["content.read", "draft.approve", "publish"],
  viewer: ["content.read"],
};

/** Unknown roles get nothing (deny by default). */
export function can(role: string, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
