// Settings → Security: two-step sign-in (authenticator app + backup codes), password change,
// and the devices you're signed in on.
import { useEffect, useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import { authClient, timeAgo } from "../lib";
import { Alert, Badge, Button, Panel } from "../ui/kit";

type SessionRow = { id: string; token: string; userAgent?: string | null; ipAddress?: string | null; createdAt: string | Date; updatedAt?: string | Date };

function qrDataUrl(text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(5, 8);
}

function device(ua: string | null | undefined) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function TwoStep({ enabled, onChange }: { enabled: boolean; onChange: () => void }) {
  const [step, setStep] = useState<"idle" | "password" | "scan" | "disable">("idle");
  const [setup, setSetup] = useState<{ uri: string; codes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await authClient.twoFactor.enable({ password: String(new FormData(e.currentTarget).get("password")) });
    setBusy(false);
    if (error || !data || data.method !== "totp") return setError(error?.message ?? "Couldn't start. Check your password.");
    setSetup({ uri: data.totpURI, codes: data.backupCodes });
    setStep("scan");
  };
  const confirm = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.twoFactor.verifyTotp({ code: String(new FormData(e.currentTarget).get("code")).replace(/\s/g, "") });
    setBusy(false);
    if (error) return setError("That code didn't match. Check the time on your phone and try the newest code.");
    setStep("idle");
    setSetup(null);
    onChange();
  };
  const disable = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.twoFactor.disable({ password: String(new FormData(e.currentTarget).get("password")) });
    setBusy(false);
    if (error) return setError(error.message ?? "Couldn't turn it off. Check your password.");
    setStep("idle");
    onChange();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">Two-step sign-in</span>
        <Badge tone={enabled ? "ok" : "neutral"}>{enabled ? "On" : "Off"}</Badge>
      </div>
      <p className="m-0 text-sm text-muted">After your password, enter a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…). Protects your account even if your password leaks.</p>
      {step === "idle" && (
        <Button variant={enabled ? "ghost" : "secondary"} className="self-start" onClick={() => setStep(enabled ? "disable" : "password")}>
          {enabled ? "Turn off" : "Turn on two-step sign-in"}
        </Button>
      )}
      {(step === "password" || step === "disable") && (
        <form className="flex flex-col gap-2" onSubmit={step === "password" ? start : disable}>
          <label>
            Your password
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
          <div className="flex gap-2">
            <Button disabled={busy}>{step === "password" ? "Continue" : "Turn off two-step sign-in"}</Button>
            <Button type="button" variant="ghost" onClick={() => setStep("idle")}>Cancel</Button>
          </div>
        </form>
      )}
      {step === "scan" && setup && (
        <form className="flex flex-col gap-3" onSubmit={confirm}>
          <p className="m-0 text-sm">1. Scan this with your authenticator app.</p>
          <img src={qrDataUrl(setup.uri)} alt="QR code for your authenticator app" width={180} height={180} className="rounded-lg bg-white p-2" />
          <details>
            <summary className="cursor-pointer text-sm">Can't scan? Enter the key by hand</summary>
            <code className="block break-all text-[12.5px]">{new URL(setup.uri).searchParams.get("secret")}</code>
          </details>
          <p className="m-0 text-sm">2. Save these backup codes somewhere safe. Each works once if you lose your phone.</p>
          <ul className="m-0 grid list-none grid-cols-2 gap-1 rounded-lg bg-sunken p-3 font-mono text-[13px]" aria-label="Backup codes">
            {setup.codes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <label>
            3. Enter the 6-digit code from the app
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required />
          </label>
          <Button className="self-start" disabled={busy}>Turn on</Button>
        </form>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get("newPassword") !== f.get("confirm")) return setError("The two new passwords don't match.");
    setBusy(true);
    setError(null);
    const { error } = await authClient.changePassword({ currentPassword: String(f.get("currentPassword")), newPassword: String(f.get("newPassword")), revokeOtherSessions: true });
    setBusy(false);
    if (error) return setError(error.message ?? "Couldn't change it. Check your current password.");
    form.reset();
    setOpen(false);
    setMessage("Password changed. You've been signed out on your other devices.");
  };
  return (
    <div className="flex flex-col gap-2">
      {!open ? (
        <Button variant="secondary" className="self-start" onClick={() => setOpen(true)}>Change password</Button>
      ) : (
        <form className="flex flex-col gap-2" onSubmit={submit}>
          <label>Current password<input name="currentPassword" type="password" required autoComplete="current-password" /></label>
          <label>New password (at least 10 characters)<input name="newPassword" type="password" required minLength={10} autoComplete="new-password" /></label>
          <label>New password again<input name="confirm" type="password" required minLength={10} autoComplete="new-password" /></label>
          <div className="flex gap-2">
            <Button disabled={busy}>Change password</Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
      {message && <Alert tone="ok">{message}</Alert>}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

function Devices({ currentToken }: { currentToken: string | undefined }) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const { data, error } = await authClient.listSessions();
    if (error) setError(error.message ?? "Couldn't load your devices.");
    else setRows((data ?? []) as SessionRow[]);
  };
  useEffect(() => {
    void load();
  }, []);
  const revoke = async (token: string) => {
    await authClient.revokeSession({ token });
    void load();
  };
  const revokeOthers = async () => {
    await authClient.revokeOtherSessions();
    void load();
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium">Where you're signed in</span>
      {error && <Alert>{error}</Alert>}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows?.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-sm">
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{device(s.userAgent)}{s.token === currentToken ? " · this device" : ""}</span>
              <span className="text-[12.5px] text-muted">Signed in {timeAgo(new Date(s.createdAt).toISOString())}</span>
            </span>
            {s.token !== currentToken && <Button size="sm" variant="ghost" onClick={() => revoke(s.token)}>Sign out</Button>}
          </li>
        ))}
      </ul>
      {rows && rows.length > 1 && <Button size="sm" variant="secondary" className="self-start" onClick={revokeOthers}>Sign out everywhere else</Button>}
    </div>
  );
}

export function SecurityPanel() {
  const { data: session, refetch } = authClient.useSession();
  const user = session?.user as ({ twoFactorEnabled?: boolean | null } & NonNullable<typeof session>["user"]) | undefined;
  return (
    <Panel title="Security" id="security">
      <TwoStep enabled={Boolean(user?.twoFactorEnabled)} onChange={() => void refetch()} />
      <hr className="border-line" />
      <ChangePassword />
      <hr className="border-line" />
      <Devices currentToken={session?.session.token} />
    </Panel>
  );
}
