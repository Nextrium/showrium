// Double-entry credit ledger. 1 credit = $0.01.
// Every transaction writes two entries that sum to zero: one on the org's balance,
// one on the platform side. The balance check and the write happen in one D1 batch
// (a single transaction on a single-writer database), so concurrent spends can't
// overdraw, and a retried request with the same idempotency key applies once.
import { and, desc, eq, sql } from "drizzle-orm";
import { creditEntry, creditTxn, type CreditTxnKind, type Db } from "@nextrium/db";
import { newId } from "./ids.js";

export class InsufficientCreditsError extends Error {
  constructor(
    readonly balance: number,
    readonly requested: number,
  ) {
    super(`Not enough credits: balance ${balance}, needs ${requested}.`);
    this.name = "InsufficientCreditsError";
  }
}

export interface PostCreditTxnInput {
  orgId: string;
  kind: CreditTxnKind;
  /** Signed change to the org's balance: positive adds credits, negative spends them. */
  amount: number;
  idempotencyKey: string;
  description: string;
}

export interface PostCreditTxnResult {
  txnId: string;
  /** false when an earlier transaction with the same idempotency key already exists. */
  applied: boolean;
}

export async function getBalance(db: Db, orgId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${creditEntry.amount}), 0)` })
    .from(creditEntry)
    .where(and(eq(creditEntry.orgId, orgId), eq(creditEntry.account, "org")));
  return Number(row?.total ?? 0);
}

export async function postCreditTxn(db: Db, input: PostCreditTxnInput): Promise<PostCreditTxnResult> {
  if (!Number.isInteger(input.amount) || input.amount === 0) {
    throw new Error("Credit amount must be a non-zero integer.");
  }
  const txnId = newId("txn");
  const now = Date.now();

  // Raw D1 batch: both statements run in one transaction.
  // 1. Insert the transaction only if the resulting balance stays >= 0 (always true for credits added).
  //    OR IGNORE: a duplicate idempotency key leaves the table unchanged instead of failing the batch.
  // 2. Insert both entries only if step 1 inserted the transaction.
  const d1 = db.$client;
  await d1.batch([
    d1
      .prepare(
        `INSERT OR IGNORE INTO credit_txn (id, org_id, kind, idempotency_key, description, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE (SELECT coalesce(sum(amount), 0) FROM credit_entry WHERE org_id = ?2 AND account = 'org') + ?7 >= 0`,
      )
      .bind(txnId, input.orgId, input.kind, input.idempotencyKey, input.description, now, input.amount),
    d1
      .prepare(
        `INSERT INTO credit_entry (id, txn_id, org_id, account, amount)
         SELECT ?1, ?3, ?4, 'org', ?5 WHERE EXISTS (SELECT 1 FROM credit_txn WHERE id = ?3)
         UNION ALL
         SELECT ?2, ?3, ?4, 'platform', -?5 WHERE EXISTS (SELECT 1 FROM credit_txn WHERE id = ?3)`,
      )
      .bind(newId("ent"), newId("ent"), txnId, input.orgId, input.amount),
  ]);

  const [inserted] = await db.select({ id: creditTxn.id }).from(creditTxn).where(eq(creditTxn.id, txnId));
  if (inserted) return { txnId, applied: true };

  const [existing] = await db
    .select({ id: creditTxn.id })
    .from(creditTxn)
    .where(and(eq(creditTxn.orgId, input.orgId), eq(creditTxn.idempotencyKey, input.idempotencyKey)));
  if (existing) return { txnId: existing.id, applied: false };

  throw new InsufficientCreditsError(await getBalance(db, input.orgId), -input.amount);
}

export async function listCreditTxns(db: Db, orgId: string, limit = 50) {
  return db
    .select({
      id: creditTxn.id,
      kind: creditTxn.kind,
      description: creditTxn.description,
      createdAt: creditTxn.createdAt,
      amount: creditEntry.amount,
    })
    .from(creditTxn)
    .innerJoin(creditEntry, and(eq(creditEntry.txnId, creditTxn.id), eq(creditEntry.account, "org")))
    .where(eq(creditTxn.orgId, orgId))
    .orderBy(desc(creditTxn.createdAt))
    .limit(limit);
}

/** Ledger integrity check: transactions whose entries don't sum to zero. Should always be empty. */
export async function findUnbalancedTxns(db: Db, orgId: string) {
  return db
    .select({ txnId: creditEntry.txnId, total: sql<number>`sum(${creditEntry.amount})` })
    .from(creditEntry)
    .where(eq(creditEntry.orgId, orgId))
    .groupBy(creditEntry.txnId)
    .having(sql`sum(${creditEntry.amount}) != 0`);
}
