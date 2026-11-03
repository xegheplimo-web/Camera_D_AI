/**
 * Harness DB dùng chung cho các test retention (T-1323…): transaction rollback,
 * đếm hàng, mốc thời gian cố định. Tách ra để SonarCloud không tính duplication
 * trên new code (>3% là fail).
 */
import { sql, TransactionRollbackError } from "drizzle-orm";
import { db } from "../../src/db";

export const DAY_MS = 86_400_000;
/** 40 ngày trước — chắc chắn quá mọi cutoff test. */
export const OLD = new Date(Date.now() - 40 * DAY_MS);
/** 1 giờ trước — luôn trong hạn giữ. */
export const FRESH = new Date(Date.now() - 3_600_000);

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Chạy thao tác huỷ diệt trong transaction rồi rollback — DB không đổi gì sau test. */
export async function inTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      tx.rollback();
    });
  } catch (e) {
    if (!(e instanceof TransactionRollbackError)) throw e;
  }
}

export async function count(tx: Tx, table: any, where?: any): Promise<number> {
  const q = tx.select({ c: sql<number>`count(*)::int` }).from(table);
  const rows = await (where ? q.where(where) : q);
  return rows[0].c;
}
