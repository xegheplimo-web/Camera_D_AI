import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeImages, knowledgeItems, productCorrections } from "@/db/schema";
import { HttpError } from "@/lib/http-guard";
import { encodeImage } from "./encoder";
import { upsertEmbedding } from "./embedding-store";

/**
 * T-1365 — người dùng sửa nhận diện sai.
 *
 * Nguyên tắc:
 *  - Lịch sử APPEND-ONLY: không ghi đè, không xoá; mỗi lần sửa là một dòng.
 *  - Ảnh được gắn vào SKU đúng (tạo `knowledge_images` nếu chưa có) và tạo
 *    embedding mới ⇒ lần nhận diện sau đúng ngay, KHÔNG cần train lại model.
 *  - Ảnh của khách chỉ nằm trong index của tenant; không dùng để train model chung.
 */

export type CorrectionInput = {
  tenantId: number;
  /** SKU đúng. */
  itemId: number;
  predictedItemId?: number | null;
  assetId?: number | null;
  imageId?: number | null;
  buffer: Buffer;
  score?: number | null;
  scoreSecond?: number | null;
  margin?: number | null;
  source?: "user" | "ocr" | "barcode";
  note?: string | null;
  userId?: number | null;
};

export type CorrectionResult = {
  correctionId: number;
  imageId: number;
  embedded: boolean;
};

async function assertItem(tenantId: number, itemId: number): Promise<void> {
  const [row] = await db
    .select({ id: knowledgeItems.id, mergedIntoId: knowledgeItems.mergedIntoId })
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.tenantId, tenantId), eq(knowledgeItems.id, itemId)))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy sản phẩm trong cửa hàng này.");
  if (row.mergedIntoId) throw new HttpError(409, "ITEM_MERGED", "Sản phẩm này đã được gộp vào sản phẩm khác.");
}

/** Tìm (hoặc tạo) dòng knowledge_images cho cặp (item, asset). */
async function ensureImage(tenantId: number, itemId: number, assetId: number, userId: number | null): Promise<number> {
  const [existing] = await db
    .select({ id: knowledgeImages.id })
    .from(knowledgeImages)
    .where(
      and(
        eq(knowledgeImages.tenantId, tenantId),
        eq(knowledgeImages.itemId, itemId),
        eq(knowledgeImages.assetId, assetId),
        isNull(knowledgeImages.deletedAt)
      )
    )
    .limit(1);
  if (existing) return Number(existing.id);
  const [created] = await db
    .insert(knowledgeImages)
    .values({ tenantId, itemId, assetId, createdBy: userId ?? null })
    .returning({ id: knowledgeImages.id });
  return Number(created.id);
}

export async function recordCorrection(input: CorrectionInput): Promise<CorrectionResult> {
  await assertItem(input.tenantId, input.itemId);
  if (input.predictedItemId != null) await assertItem(input.tenantId, input.predictedItemId);

  let imageId = input.imageId ?? null;
  if (imageId == null) {
    if (input.assetId == null) throw new HttpError(400, "MISSING_ASSET", "Cần assetId để gắn ảnh vào sản phẩm.");
    imageId = await ensureImage(input.tenantId, input.itemId, input.assetId, input.userId ?? null);
  }

  const { vec } = await encodeImage(input.buffer);
  await upsertEmbedding({ tenantId: input.tenantId, itemId: input.itemId, imageId, vec });

  const [row] = await db
    .insert(productCorrections)
    .values({
      tenantId: input.tenantId,
      itemId: input.itemId,
      predictedItemId: input.predictedItemId ?? null,
      imageId,
      assetId: input.assetId ?? null,
      score: input.score ?? null,
      scoreSecond: input.scoreSecond ?? null,
      margin: input.margin ?? null,
      source: input.source ?? "user",
      note: input.note ?? null,
      createdBy: input.userId ?? null,
    })
    .returning({ id: productCorrections.id });

  return { correctionId: Number(row.id), imageId, embedded: true };
}

export type CorrectionStats = {
  total: number;
  byItem: { itemId: number; title: string | null; count: number }[];
  confusedPairs: { predictedItemId: number; itemId: number; count: number }[];
};

/** Thống kê để biết SKU nào hay bị nhận nhầm (không lộ thuật ngữ nội bộ ra UI). */
export async function correctionStats(tenantId: number, limit = 10): Promise<CorrectionStats> {
  const totalRes = await db.execute(
    sql`select count(*)::int as n from product_corrections where tenant_id = ${tenantId}`
  );
  const total = Number((totalRes.rows?.[0] as { n: number } | undefined)?.n ?? 0);

  const byItemRes = await db.execute(sql`
    select c.item_id as "itemId", i.title, count(*)::int as count
    from product_corrections c
    left join knowledge_items i on i.id = c.item_id and i.tenant_id = c.tenant_id
    where c.tenant_id = ${tenantId}
    group by 1, 2
    order by count desc
    limit ${limit}
  `);

  const pairsRes = await db.execute(sql`
    select predicted_item_id as "predictedItemId", item_id as "itemId", count(*)::int as count
    from product_corrections
    where tenant_id = ${tenantId} and predicted_item_id is not null
    group by 1, 2
    order by count desc
    limit ${limit}
  `);

  return {
    total,
    byItem: (byItemRes.rows ?? []) as CorrectionStats["byItem"],
    confusedPairs: (pairsRes.rows ?? []) as CorrectionStats["confusedPairs"],
  };
}
