import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readCookie } from "@nextrium/core";

// Email is off in this project: invites come back as links to share by hand (see with-email for sending).
const BASE = "http://localhost:5173";
let n = 0;
const ip = () => `10.44.${Math.floor(++n / 250)}.${n % 250}`;
const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

const auth = (path: string, body: unknown, cookie = "") =>
  SELF.fetch(`${BASE}/api/auth${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip(), ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const v1 = (method: string, path: string, cookie: string, body?: unknown) =>
  SELF.fetch(`${BASE}/api/v1${path}`, { method, headers: { Cookie: cookie, Origin: BASE, "CF-Connecting-IP": ip(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

async function session(email: string) {
  const up = await auth("/sign-up/email", { email, name: "Person", password: "correct-horse-battery" });
  if (up.status === 200) return cookieOf(up);
  return cookieOf(await auth("/sign-in/email", { email, password: "correct-horse-battery" }));
}
const join = (email: string) => SELF.fetch(`${BASE}/api/v1/waitlist`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": ip() }, body: JSON.stringify({ email }) });
type Entry = { id: string; email: string; status: string; invitedAt: string | null; joinedAt: string | null };
const list = async (cookie: string) => ((await (await v1("GET", "/admin/waitlist", cookie)).json()) as { data: Entry[] }).data;

describe("waitlist: one-click invites", () => {
  it("only staff can see or invite", async () => {
    const someone = await session("not-staff@example.com");
    expect((await v1("GET", "/admin/waitlist", someone)).status).toBe(403);
    expect((await v1("POST", "/admin/waitlist/invite", someone, { ids: ["wl_x"] })).status).toBe(403);
  });

  it("invites selected people; each gets their own Free workspace, and shows as joined", async () => {
    const admin = await session("admin@example.com");
    for (const e of ["ada@wl.test", "bola@wl.test", "chi@wl.test"]) expect((await join(e)).status).toBeLessThan(300);
    const before = (await list(admin)).filter((e) => e.email.endsWith("@wl.test"));
    expect(before.map((e) => e.status)).toEqual(["waiting", "waiting", "waiting"]);

    // Waitlisted emails can't sign up on their own (allowlist mode only lets @example.com in).
    expect((await auth("/sign-up/email", { email: "ada@wl.test", name: "Ada", password: "correct-horse-battery" })).status).not.toBe(200);

    const ada = before.find((e) => e.email === "ada@wl.test")!;
    const bola = before.find((e) => e.email === "bola@wl.test")!;
    const res = await v1("POST", "/admin/waitlist/invite", admin, { ids: [ada.id, bola.id] });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { data: { id: string; email: string; sent: boolean; link: string | null }[] };
    expect(out.data.map((d) => [d.email, d.sent])).toEqual(expect.arrayContaining([["ada@wl.test", false], ["bola@wl.test", false]]));
    expect(out.data.every((d) => d.link?.startsWith(`${BASE}/invite?token=inv_`))).toBe(true); // not emailed, so shown to share

    const mid = await list(admin);
    expect(mid.find((e) => e.email === "ada@wl.test")!.status).toBe("invited");
    expect(mid.find((e) => e.email === "chi@wl.test")!.status).toBe("waiting");

    // Ada opens the link and signs up: her own workspace, Free plan, owner. Not the admin's.
    const token = new URL(out.data.find((d) => d.email === "ada@wl.test")!.link!).searchParams.get("token")!;
    const accepted = await SELF.fetch(`${BASE}/api/v1/invites/accept`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() }, body: JSON.stringify({ token }) });
    expect(accepted.status).toBe(200);
    const inviteCookie = `showrium_invite=${readCookie(accepted.headers.get("set-cookie"), "showrium_invite")}`;
    const signUp = await auth("/sign-up/email", { email: "ada@wl.test", name: "Ada", password: "correct-horse-battery" }, inviteCookie);
    expect(signUp.status).toBe(200);
    const me = (await (await v1("GET", "/me", cookieOf(signUp))).json()) as { workspace: { id: string; plan: string }; principal: { role: string } };
    expect(me.workspace.plan).toBe("free");
    expect(me.principal.role).toBe("owner");
    const adminMe = (await (await v1("GET", "/me", admin)).json()) as { workspace: { id: string } };
    expect(me.workspace.id).not.toBe(adminMe.workspace.id);
    const members = await env.DB.prepare("SELECT count(*) AS n FROM membership m JOIN user u ON u.id = m.user_id WHERE u.email = 'ada@wl.test'").first<{ n: number }>();
    expect(members!.n).toBe(1);

    const after = await list(admin);
    expect(after.find((e) => e.email === "ada@wl.test")).toMatchObject({ status: "joined", joinedAt: expect.any(String) });
    expect(after.find((e) => e.email === "bola@wl.test")!.status).toBe("invited");
  });

  it("re-inviting replaces the old link; joined people are skipped", async () => {
    const admin = await session("admin@example.com");
    await join("dayo@wl.test");
    const dayo = (await list(admin)).find((e) => e.email === "dayo@wl.test")!;
    const first = ((await (await v1("POST", "/admin/waitlist/invite", admin, { ids: [dayo.id] })).json()) as { data: { link: string }[] }).data[0]!.link;
    const second = ((await (await v1("POST", "/admin/waitlist/invite", admin, { ids: [dayo.id] })).json()) as { data: { link: string }[] }).data[0]!.link;
    expect(second).not.toBe(first);
    const tok = (l: string) => new URL(l).searchParams.get("token")!;
    const accept = (t: string) => SELF.fetch(`${BASE}/api/v1/invites/accept`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() }, body: JSON.stringify({ token: t }) });
    expect((await accept(tok(first))).status).toBe(400); // the old link no longer works
    expect((await accept(tok(second))).status).toBe(200);

    // Someone who already has an account is shown as joined and not invited again.
    await join("admin@example.com");
    const adminEntry = (await list(admin)).find((e) => e.email === "admin@example.com")!;
    expect(adminEntry.status).toBe("joined");
    const res = (await (await v1("POST", "/admin/waitlist/invite", admin, { ids: [adminEntry.id] })).json()) as { data: unknown[]; skipped: number };
    expect(res).toEqual({ data: [], skipped: 1 });
  });
});
