// Billing: checkout links, signed webhooks, subscriptions and credit packs.
// Paystack sells in NGN (low fees for local cards); Lemon Squeezy sells worldwide as merchant of record.
//
// Trust model:
// - Webhooks are accepted only with a valid provider signature (HMAC over the raw body, constant-time compare).
// - Every checkout carries our own signed custom data (org, item). Events whose custom data isn't signed by
//   us are ignored, so a payment made outside our checkout can't target another workspace.
// - Each event is recorded once (provider + event key); a retried delivery is a no-op.
// - Credit packs are granted only when the paid amount and currency match the pack.
import { and, asc, eq, inArray, like, lt } from "drizzle-orm";
import { creditEntry, creditTxn, org, paymentEvent, subscription, type BillingProvider, type Db, type PaidPlan } from "@nextrium/db";
import { getBalance, postCreditTxn } from "./credits.js";
import { newId } from "./ids.js";
import { recordAudit } from "./orgs.js";
import type { Plan } from "./plans.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type Interval = "month" | "year";

/** Prices in US cents (cost-model-and-pricing.md). Lite is sold through Paystack only (card fees). */
export const PLAN_PRICES: Record<Exclude<PaidPlan, "team">, Partial<Record<Interval, number>>> = {
  lite: { month: 100 },
  starter: { month: 300, year: 3000 },
  creator: { month: 600, year: 6000 },
  pro: { month: 1000, year: 10000 },
};
export const CREDIT_PACKS = {
  c500: { credits: 500, usdCents: 500 },
  c1100: { credits: 1100, usdCents: 1000 },
} as const;
export type CreditPack = keyof typeof CREDIT_PACKS;

export type CheckoutItem = { kind: "plan"; plan: Exclude<PaidPlan, "team">; interval: Interval } | { kind: "credits"; pack: CreditPack };
export const itemKey = (item: CheckoutItem) => (item.kind === "plan" ? `${item.plan}:${item.interval}` : `credits:${item.pack}`);

export interface BillingConfig {
  /** Signs our checkout custom data (derived from a server secret). */
  signingSecret: string;
  /** Where the provider sends the buyer back to. */
  returnUrl: string;
  paystack?: { secretKey: string; plans: Record<string, string>; ngnPerUsd: number } | undefined;
  lemonsqueezy?:
    | {
        apiKey: string;
        storeId: string;
        webhookSecret: string;
        variants: Record<string, string>;
      }
    | undefined;
  fetch?: FetchLike | undefined;
}

export class BillingError extends Error {
  constructor(
    readonly code: "not_configured" | "not_available" | "provider_error" | "no_subscription",
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

// --- Crypto helpers ---------------------------------------------------------------------

const enc = new TextEncoder();
async function hmacHex(algorithm: "SHA-256" | "SHA-512", secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: algorithm }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function verifySignature(provider: BillingProvider, secret: string, rawBody: string, signature: string | null | undefined) {
  if (!secret || !signature) return false;
  const expected = await hmacHex(provider === "paystack" ? "SHA-512" : "SHA-256", secret, rawBody);
  return safeEqual(expected, signature.trim().toLowerCase());
}

/** Our custom data, signed so webhooks can trust which workspace and item a payment is for. */
export async function signCustom(secret: string, orgId: string, item: string) {
  return {
    org_id: orgId,
    item,
    sig: (await hmacHex("SHA-256", secret, `showrium-billing:${orgId}:${item}`)).slice(0, 32),
  };
}
async function readCustom(secret: string, custom: unknown): Promise<{ orgId: string; item: string } | null> {
  const c = (typeof custom === "string" ? safeJson(custom) : custom) as {
    org_id?: unknown;
    item?: unknown;
    sig?: unknown;
  } | null;
  if (!c || typeof c.org_id !== "string" || typeof c.item !== "string" || typeof c.sig !== "string") return null;
  const good = (await signCustom(secret, c.org_id, c.item)).sig;
  return safeEqual(good, c.sig) ? { orgId: c.org_id, item: c.item } : null;
}
function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- Checkout ------------------------------------------------------------------------------

export function providersFor(cfg: BillingConfig, item: CheckoutItem): BillingProvider[] {
  const key = itemKey(item);
  const out: BillingProvider[] = [];
  if (cfg.paystack && (item.kind === "credits" || cfg.paystack.plans[key])) out.push("paystack");
  // Lite is Paystack-only: a $1 card charge through a merchant of record loses about half to fees.
  if (cfg.lemonsqueezy?.variants[key] && !(item.kind === "plan" && item.plan === "lite")) out.push("lemonsqueezy");
  return out;
}

export async function createCheckout(
  cfg: BillingConfig,
  input: {
    orgId: string;
    email: string;
    provider: BillingProvider;
    item: CheckoutItem;
  },
): Promise<string> {
  if (input.item.kind === "plan" && !PLAN_PRICES[input.item.plan][input.item.interval]) throw new BillingError("not_available", "That plan isn't sold with that billing period.");
  if (!providersFor(cfg, input.item).includes(input.provider)) throw new BillingError("not_configured", "This payment option isn't set up yet.");
  const key = itemKey(input.item);
  const custom = await signCustom(cfg.signingSecret, input.orgId, key);
  const doFetch = cfg.fetch ?? fetch;
  let res: Response;
  try {
    if (input.provider === "paystack") {
      const p = cfg.paystack!;
      const usdCents = input.item.kind === "credits" ? CREDIT_PACKS[input.item.pack].usdCents : PLAN_PRICES[input.item.plan][input.item.interval]!;
      res = await doFetch("https://api.paystack.co/transaction/initialize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${p.secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: input.email,
          currency: "NGN",
          amount: Math.round(usdCents * p.ngnPerUsd), // kobo: cents/100 * rate * 100
          ...(input.item.kind === "plan" ? { plan: p.plans[key] } : {}),
          callback_url: cfg.returnUrl,
          metadata: custom,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as {
        status?: boolean;
        data?: { authorization_url?: string };
      };
      if (!res.ok || !body.status || !body.data?.authorization_url) throw new Error(`paystack ${res.status}`);
      return body.data.authorization_url;
    }
    const l = cfg.lemonsqueezy!;
    res = await doFetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${l.apiKey}`,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
      body: JSON.stringify({
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: { email: input.email, custom },
            product_options: { redirect_url: cfg.returnUrl },
          },
          relationships: {
            store: { data: { type: "stores", id: l.storeId } },
            variant: { data: { type: "variants", id: l.variants[key] } },
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as {
      data?: { attributes?: { url?: string } };
    };
    if (!res.ok || !body.data?.attributes?.url) throw new Error(`lemonsqueezy ${res.status}`);
    return body.data.attributes.url;
  } catch (error) {
    console.error("checkout failed", {
      provider: input.provider,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new BillingError("provider_error", "The payment provider didn't respond. Please try again.");
  }
}

// --- Subscriptions ------------------------------------------------------------------------

type SubStatus = "active" | "past_due" | "cancelled" | "expired";
const KEEPS_PLAN: SubStatus[] = ["active", "past_due", "cancelled"];

export async function getSubscription(db: Db, orgId: string) {
  const [row] = await db.select().from(subscription).where(eq(subscription.orgId, orgId));
  return row ?? null;
}

export async function setOrgPlan(db: Db, orgId: string, plan: Plan, meta: { actorUserId?: string | null; reason: string }) {
  const [row] = await db.update(org).set({ plan }).where(eq(org.id, orgId)).returning({ id: org.id });
  if (row)
    await recordAudit(db, {
      orgId,
      actorUserId: meta.actorUserId ?? null,
      action: "plan.changed",
      target: orgId,
      meta: { plan, reason: meta.reason },
    });
  return Boolean(row);
}

/**
 * Applies a subscription state from a verified webhook. A different subscription never replaces one that
 * is still active for the workspace: that case is recorded as a conflict for a human to look at.
 */
async function applySubscription(
  db: Db,
  s: {
    orgId: string;
    provider: BillingProvider;
    plan: PaidPlan;
    interval: Interval;
    status: SubStatus;
    providerSubscriptionId: string;
    providerCustomerId: string | null;
    currentPeriodEnd: Date | null;
    providerUpdatedAt?: Date | null;
  },
): Promise<"applied" | "conflict"> {
  const existing = await getSubscription(db, s.orgId);
  if (
    existing &&
    existing.status === "active" &&
    (existing.provider !== s.provider || existing.providerSubscriptionId !== s.providerSubscriptionId) &&
    !existing.providerSubscriptionId.startsWith("pending:")
  ) {
    if (s.status === "active") return "conflict";
    return "applied"; // an old or other subscription ending doesn't affect the active one
  }
  const values = { ...s, updatedAt: new Date() };
  await db
    .insert(subscription)
    .values({ id: newId("sub"), ...values })
    .onConflictDoUpdate({ target: subscription.orgId, set: values });
  await setOrgPlan(db, s.orgId, KEEPS_PLAN.includes(s.status) ? s.plan : "free", { reason: `${s.provider} subscription ${s.status}` });
  return "applied";
}

/** Housekeeping: ends plans whose paid period is over (cancelled, unpaid past a 3-day grace, or silent for 7 days). */
export async function expireSubscriptions(db: Db, now = new Date()) {
  const rows = await db
    .select()
    .from(subscription)
    .where(and(inArray(subscription.status, ["active", "past_due", "cancelled"]), lt(subscription.currentPeriodEnd, now)));
  let expired = 0;
  for (const s of rows) {
    const end = s.currentPeriodEnd!.getTime();
    const grace = s.status === "cancelled" ? 0 : s.status === "past_due" ? 3 * 86_400_000 : 7 * 86_400_000;
    if (end + grace > now.getTime()) continue;
    await db.update(subscription).set({ status: "expired", updatedAt: now }).where(eq(subscription.id, s.id));
    await setOrgPlan(db, s.orgId, "free", {
      reason: `subscription expired (${s.status})`,
    });
    expired++;
  }
  return expired;
}

export async function portalUrl(cfg: BillingConfig, sub: typeof subscription.$inferSelect): Promise<string> {
  const doFetch = cfg.fetch ?? fetch;
  try {
    if (sub.provider === "lemonsqueezy" && cfg.lemonsqueezy) {
      const res = await doFetch(`https://api.lemonsqueezy.com/v1/subscriptions/${encodeURIComponent(sub.providerSubscriptionId)}`, {
        headers: {
          Authorization: `Bearer ${cfg.lemonsqueezy.apiKey}`,
          Accept: "application/vnd.api+json",
        },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as {
        data?: { attributes?: { urls?: { customer_portal?: string } } };
      };
      const url = body.data?.attributes?.urls?.customer_portal;
      if (res.ok && url) return url;
    }
    if (sub.provider === "paystack" && cfg.paystack && !sub.providerSubscriptionId.startsWith("pending:")) {
      const res = await doFetch(`https://api.paystack.co/subscription/${encodeURIComponent(sub.providerSubscriptionId)}/manage/link`, {
        headers: { Authorization: `Bearer ${cfg.paystack.secretKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { data?: { link?: string } };
      if (res.ok && body.data?.link) return body.data.link;
    }
  } catch {
    // fall through
  }
  throw new BillingError("provider_error", "Couldn't open the billing page. Please try again.");
}

/**
 * A refunded credit pack: removes the purchased credits. If some were already spent, removes what's left
 * and reports a partial reversal (visible in payment events for follow-up).
 */
async function reversePurchase(db: Db, purchaseKey: string, refundKey: string) {
  const [txn] = await db
    .select({ orgId: creditTxn.orgId, amount: creditEntry.amount })
    .from(creditTxn)
    .innerJoin(creditEntry, and(eq(creditEntry.txnId, creditTxn.id), eq(creditEntry.account, "org")))
    .where(and(eq(creditTxn.idempotencyKey, purchaseKey), eq(creditTxn.kind, "purchase")));
  if (!txn) return "unknown_purchase";
  const take = Math.min(txn.amount, await getBalance(db, txn.orgId));
  if (take > 0) await postCreditTxn(db, { orgId: txn.orgId, kind: "adjustment", amount: -take, idempotencyKey: refundKey, description: "Refund: credits removed" });
  return take === txn.amount ? "credits_reversed" : "partial_reversal";
}

// --- Webhooks --------------------------------------------------------------------------------

/** Records the event once. Returns false for a duplicate delivery. */
async function firstDelivery(db: Db, provider: BillingProvider, eventKey: string, type: string) {
  const [row] = await db
    .insert(paymentEvent)
    .values({
      id: newId("pev"),
      provider,
      eventKey: eventKey.slice(0, 300),
      type: type.slice(0, 60),
    })
    .onConflictDoNothing()
    .returning({ id: paymentEvent.id });
  return row?.id ?? null;
}
/** Runs a handler once per event. If it throws, the record is released so the provider's retry is processed. */
async function once(db: Db, provider: BillingProvider, eventKey: string, type: string, fn: (eventId: string) => Promise<string>) {
  const eventId = await firstDelivery(db, provider, eventKey, type);
  if (!eventId) return "duplicate";
  try {
    return await fn(eventId);
  } catch (error) {
    await db.delete(paymentEvent).where(eq(paymentEvent.id, eventId));
    throw error;
  }
}
async function finish(db: Db, id: string, outcome: string, orgId: string | null) {
  await db.update(paymentEvent).set({ outcome, orgId }).where(eq(paymentEvent.id, id));
  return outcome;
}
const parsePlanKey = (key: string): { plan: PaidPlan; interval: Interval } | null => {
  const [plan, interval] = key.split(":");
  return plan && plan in PLAN_PRICES && (interval === "month" || interval === "year") ? { plan: plan as PaidPlan, interval } : null;
};
const reverse = (map: Record<string, string>, value: string | number | undefined | null) => Object.entries(map).find(([, v]) => String(v) === String(value))?.[0] ?? null;
const addInterval = (from: Date, interval: Interval) => new Date(from.getTime() + (interval === "year" ? 366 : 31) * 86_400_000);

type PaystackEvent = {
  event: string;
  data: {
    id?: number | string;
    reference?: string;
    amount?: number;
    currency?: string;
    status?: string;
    metadata?: unknown;
    plan?: { plan_code?: string } | null;
    customer?: { customer_code?: string };
    subscription_code?: string;
    next_payment_date?: string | null;
    subscription?: { subscription_code?: string; next_payment_date?: string | null };
    paid?: boolean;
    transaction_reference?: string;
  };
};

export async function handlePaystackEvent(db: Db, cfg: BillingConfig, e: PaystackEvent, now = new Date()): Promise<string> {
  const p = cfg.paystack;
  if (!p) return "not_configured";
  const d = e.data ?? {};
  const key = `${e.event}:${d.id ?? d.reference ?? d.subscription_code ?? "?"}`;
  return once(db, "paystack", key, e.event, async (eventId) => {
    const customer = d.customer?.customer_code ?? null;
    const planKey = d.plan?.plan_code ? reverse(p.plans, d.plan.plan_code) : null;

    if (e.event === "charge.success" && d.status === "success") {
      const custom = await readCustom(cfg.signingSecret, d.metadata);
      if (custom?.item.startsWith("credits:")) {
        const pack = CREDIT_PACKS[custom.item.slice(8) as CreditPack];
        if (!pack) return finish(db, eventId, "unknown_item", custom.orgId);
        if (d.currency !== "NGN" || (d.amount ?? 0) < Math.round(pack.usdCents * p.ngnPerUsd)) return finish(db, eventId, "amount_mismatch", custom.orgId);
        await postCreditTxn(db, {
          orgId: custom.orgId,
          kind: "purchase",
          amount: pack.credits,
          idempotencyKey: `paystack:${d.reference}`,
          description: `${pack.credits} credits`,
        });
        return finish(db, eventId, "credits_granted", custom.orgId);
      }
      if (custom && planKey && custom.item === planKey) {
        // First payment of a subscription. The subscription code arrives in subscription.create.
        const parsed = parsePlanKey(planKey)!;
        const out = await applySubscription(db, {
          orgId: custom.orgId,
          provider: "paystack",
          ...parsed,
          status: "active",
          providerSubscriptionId: `pending:${custom.orgId}:${customer}:${d.plan!.plan_code}`,
          providerCustomerId: customer,
          currentPeriodEnd: addInterval(now, parsed.interval),
        });
        return finish(db, eventId, out, custom.orgId);
      }
      if (!custom && planKey && customer) {
        // A renewal: Paystack charges the saved card; no metadata. Extend the matching subscription,
        // but only when exactly one matches (one person can pay for several workspaces).
        const parsed = parsePlanKey(planKey)!;
        const subs = await db
          .select()
          .from(subscription)
          .where(and(eq(subscription.provider, "paystack"), eq(subscription.providerCustomerId, customer), eq(subscription.plan, parsed.plan), eq(subscription.interval, parsed.interval)));
        if (subs.length !== 1) return finish(db, eventId, subs.length ? "ambiguous_renewal" : "unknown_subscription", null);
        const sub = subs[0]!;
        await db
          .update(subscription)
          .set({
            status: "active",
            currentPeriodEnd: addInterval(now, sub.interval),
            updatedAt: now,
          })
          .where(eq(subscription.id, sub.id));
        await setOrgPlan(db, sub.orgId, sub.plan, {
          reason: "paystack renewal",
        });
        return finish(db, eventId, "renewed", sub.orgId);
      }
      return finish(db, eventId, "ignored_unsigned", null);
    }

    const code = d.subscription_code ?? d.subscription?.subscription_code;
    if (e.event === "invoice.update" && d.paid && code) {
      // A paid renewal invoice names its subscription exactly.
      const [sub] = await db.select().from(subscription).where(and(eq(subscription.provider, "paystack"), eq(subscription.providerSubscriptionId, code)));
      if (!sub) return finish(db, eventId, "unknown_subscription", null);
      const next = d.subscription?.next_payment_date ? new Date(d.subscription.next_payment_date) : addInterval(now, sub.interval);
      await db.update(subscription).set({ status: "active", currentPeriodEnd: next, updatedAt: now }).where(eq(subscription.id, sub.id));
      await setOrgPlan(db, sub.orgId, sub.plan, { reason: "paystack renewal" });
      return finish(db, eventId, "renewed", sub.orgId);
    }
    if (e.event === "refund.processed" && d.transaction_reference) {
      return finish(db, eventId, await reversePurchase(db, `paystack:${d.transaction_reference}`, `paystack-refund:${d.transaction_reference}`), null);
    }
    if (e.event === "subscription.create" && code && customer && planKey) {
      const [sub] = await db
        .select()
        .from(subscription)
        .where(
          and(
            eq(subscription.provider, "paystack"),
            eq(subscription.providerCustomerId, customer),
            like(subscription.providerSubscriptionId, `pending:%:${customer}:${d.plan!.plan_code}`),
          ),
        )
        // Same payer, several workspaces: Paystack creates subscriptions in payment order.
        .orderBy(asc(subscription.createdAt))
        .limit(1);
      if (!sub) return finish(db, eventId, "unknown_subscription", null);
      await db
        .update(subscription)
        .set({
          providerSubscriptionId: code,
          currentPeriodEnd: d.next_payment_date ? new Date(d.next_payment_date) : sub.currentPeriodEnd,
          updatedAt: now,
        })
        .where(eq(subscription.id, sub.id));
      return finish(db, eventId, "linked", sub.orgId);
    }
    if ((e.event === "subscription.not_renew" || e.event === "subscription.disable" || e.event === "invoice.payment_failed") && code) {
      const [sub] = await db
        .select()
        .from(subscription)
        .where(and(eq(subscription.provider, "paystack"), eq(subscription.providerSubscriptionId, code)));
      if (!sub) return finish(db, eventId, "unknown_subscription", null);
      const status: SubStatus = e.event === "invoice.payment_failed" ? "past_due" : "cancelled";
      await db.update(subscription).set({ status, updatedAt: now }).where(eq(subscription.id, sub.id));
      await recordAudit(db, {
        orgId: sub.orgId,
        action: "subscription.updated",
        target: sub.id,
        meta: { status, provider: "paystack" },
      });
      return finish(db, eventId, status, sub.orgId);
    }
    return finish(db, eventId, "ignored", null);
  });
}

type LemonEvent = {
  meta: { event_name: string; custom_data?: unknown };
  data: {
    id: string;
    attributes: {
      status?: string;
      total?: number;
      currency?: string;
      variant_id?: number | string;
      first_order_item?: { variant_id?: number | string };
      customer_id?: number | string;
      renews_at?: string | null;
      ends_at?: string | null;
      updated_at?: string;
    };
  };
};

const LEMON_STATUS: Record<string, SubStatus> = {
  active: "active",
  on_trial: "active",
  past_due: "past_due",
  unpaid: "past_due",
  paused: "past_due",
  cancelled: "cancelled",
  expired: "expired",
};

export async function handleLemonEvent(db: Db, cfg: BillingConfig, e: LemonEvent): Promise<string> {
  const l = cfg.lemonsqueezy;
  if (!l) return "not_configured";
  const a = e.data?.attributes ?? {};
  return once(db, "lemonsqueezy", `${e.meta.event_name}:${e.data?.id}:${a.updated_at ?? ""}`, e.meta.event_name, async (eventId) => {
    const custom = await readCustom(cfg.signingSecret, e.meta.custom_data);
    if (!custom) return finish(db, eventId, "ignored_unsigned", null);

    if (e.meta.event_name === "order_created") {
      if (!custom.item.startsWith("credits:")) return finish(db, eventId, "ignored", custom.orgId); // plan orders arrive as subscription events
      const pack = CREDIT_PACKS[custom.item.slice(8) as CreditPack];
      const variantItem = reverse(l.variants, a.first_order_item?.variant_id);
      if (!pack || variantItem !== custom.item) return finish(db, eventId, "unknown_item", custom.orgId);
      if (a.status !== "paid") return finish(db, eventId, "not_paid", custom.orgId);
      await postCreditTxn(db, {
        orgId: custom.orgId,
        kind: "purchase",
        amount: pack.credits,
        idempotencyKey: `lemonsqueezy:order:${e.data.id}`,
        description: `${pack.credits} credits`,
      });
      return finish(db, eventId, "credits_granted", custom.orgId);
    }

    if (e.meta.event_name === "order_refunded" && custom.item.startsWith("credits:")) {
      return finish(db, eventId, await reversePurchase(db, `lemonsqueezy:order:${e.data.id}`, `lemonsqueezy:refund:${e.data.id}`), custom.orgId);
    }

    if (e.meta.event_name.startsWith("subscription_")) {
      // Webhooks can arrive out of order: never let an older state overwrite a newer one.
      const current = await getSubscription(db, custom.orgId);
      const at = a.updated_at ? new Date(a.updated_at) : null;
      if (current?.provider === "lemonsqueezy" && current.providerSubscriptionId === String(e.data.id) && current.providerUpdatedAt && at && at < current.providerUpdatedAt) {
        return finish(db, eventId, "stale", custom.orgId);
      }
      const variantItem = reverse(l.variants, a.variant_id);
      const parsed = variantItem ? parsePlanKey(variantItem) : null;
      // The variant must match what our signed checkout was for.
      if (!parsed || variantItem !== custom.item) return finish(db, eventId, "unknown_item", custom.orgId);
      const status = LEMON_STATUS[a.status ?? ""] ?? "past_due";
      const end = a.ends_at ?? a.renews_at;
      const out = await applySubscription(db, {
        orgId: custom.orgId,
        provider: "lemonsqueezy",
        ...parsed,
        status,
        providerSubscriptionId: String(e.data.id),
        providerCustomerId: a.customer_id ? String(a.customer_id) : null,
        currentPeriodEnd: end ? new Date(end) : null,
        providerUpdatedAt: at,
      });
      return finish(db, eventId, out === "conflict" ? "conflict" : status, custom.orgId);
    }
    return finish(db, eventId, "ignored", custom.orgId);
  });
}
