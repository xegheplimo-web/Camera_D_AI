import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db";
import {
  knowledgeImages,
  knowledgeItems,
  knowledgeMergeLog,
  knowledgePairDecisions,
  knowledgePriceHistory,
} from "../../src/db/schema";
import { toIdentity } from "../../src/lib/knowledge/normalize";

/**
 * Helper dùng chung cho test knowledge (T-1355/T-1356/T-1351).
 * Tạo item tối thiểu + dọn sạch mọi bảng phụ thuộc theo danh sách id.
 */

export async function mkKnowledgeItem(tenantId: number, patch: Record<string, unknown>): Promise<number> {
  const [row] = await db
    .insert(knowledgeItems)
    .values({
      tenantId,
      scope: "camera",
      title: String(patch.title ?? "Sản phẩm"),
      priceVnd: typeof patch.priceVnd === "number" ? patch.priceVnd : null,
      cameraId: typeof patch.cameraId === "number" ? patch.cameraId : null,
      custom: (patch.custom ?? {}) as Record<string, unknown>,
    })
    .returning({ id: knowledgeItems.id });
  return Number(row.id);
}

export async function itemSide(tenantId: number, id: number) {
  const [row] = await db
    .select({ id: knowledgeItems.id, title: knowledgeItems.title, custom: knowledgeItems.custom })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, id));
  return { id: Number(row.id), title: row.title, identity: toIdentity((row.custom ?? {}) as Record<string, unknown>) };
}

/** Xoá item + mọi bản ghi phụ thuộc (ảnh, giá, log gộp, quyết định cặp). */
export async function cleanupKnowledgeItems(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const list = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  await db
    .delete(knowledgePairDecisions)
    .where(sql`${knowledgePairDecisions.minItemId} in (${list}) or ${knowledgePairDecisions.maxItemId} in (${list})`);
  await db
    .delete(knowledgeMergeLog)
    .where(sql`${knowledgeMergeLog.sourceId} in (${list}) or ${knowledgeMergeLog.targetId} in (${list})`);
  await db.delete(knowledgeImages).where(sql`${knowledgeImages.itemId} in (${list})`);
  await db.delete(knowledgePriceHistory).where(sql`${knowledgePriceHistory.itemId} in (${list})`);
  await db.delete(knowledgeItems).where(sql`${knowledgeItems.id} in (${list})`);
}

/** Tạo asset tối thiểu để ảnh có FK hợp lệ. */
export async function mkAsset(tenantId: number, tag: string): Promise<number> {
  const res = await db.execute(sql`
    insert into assets (tenant_id, kind, url, origin, mime, sha256, size_bytes)
    values (${tenantId}, 'image', ${`/test/${tag}.jpg`}, 'test', 'image/jpeg', ${`test-${tag}`}, 1024)
    returning id
  `);
  return Number((res.rows?.[0] as { id: number | string }).id);
}
