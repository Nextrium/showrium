import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDb, org } from "@nextrium/db";
import { findUnbalancedTxns, getBalance, InsufficientCreditsError, newId, postCreditTxn } from "@nextrium/core";

async function freshOrg() {
  const db = createDb(env.DB);
  const id = newId("org");
  await db.insert(org).values({ id, name: "Ledger test", slug: id.toLowerCase() });
  return { db, orgId: id };
}

describe("credit ledger", () => {
  it("adds and spends credits", async () => {
    const { db, orgId } = await freshOrg();
    await postCreditTxn(db, { orgId, kind: "purchase", amount: 500, idempotencyKey: "p1", description: "Pack" });
    await postCreditTxn(db, { orgId, kind: "spend", amount: -25, idempotencyKey: "s1", description: "X post with link" });
    expect(await getBalance(db, orgId)).toBe(475);
  });

  it("never lets a balance go below zero", async () => {
    const { db, orgId } = await freshOrg();
    await postCreditTxn(db, { orgId, kind: "grant", amount: 10, idempotencyKey: "g1", description: "Grant" });
    await expect(
      postCreditTxn(db, { orgId, kind: "spend", amount: -11, idempotencyKey: "s1", description: "Too much" }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(await getBalance(db, orgId)).toBe(10);
  });

  it("applies a retried request only once", async () => {
    const { db, orgId } = await freshOrg();
    const first = await postCreditTxn(db, { orgId, kind: "grant", amount: 100, idempotencyKey: "same", description: "Grant" });
    const retry = await postCreditTxn(db, { orgId, kind: "grant", amount: 100, idempotencyKey: "same", description: "Grant" });
    expect(first.applied).toBe(true);
    expect(retry).toEqual({ txnId: first.txnId, applied: false });
    expect(await getBalance(db, orgId)).toBe(100);
  });

  it("keeps every transaction balanced (entries sum to zero)", async () => {
    const { db, orgId } = await freshOrg();
    await postCreditTxn(db, { orgId, kind: "purchase", amount: 1100, idempotencyKey: "a", description: "Pack" });
    for (let i = 0; i < 20; i++) {
      await postCreditTxn(db, { orgId, kind: "spend", amount: -(1 + (i % 7)), idempotencyKey: `s${i}`, description: "Spend" });
    }
    const unbalanced = await findUnbalancedTxns(db, orgId);
    expect(unbalanced).toEqual([]);
  });

  it("rejects zero and fractional amounts", async () => {
    const { db, orgId } = await freshOrg();
    await expect(postCreditTxn(db, { orgId, kind: "grant", amount: 0, idempotencyKey: "z", description: "Zero" })).rejects.toThrow();
    await expect(postCreditTxn(db, { orgId, kind: "grant", amount: 1.5, idempotencyKey: "f", description: "Frac" })).rejects.toThrow();
  });
});
