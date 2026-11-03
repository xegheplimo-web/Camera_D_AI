import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeImages, knowledgeItems, knowledgeMergeLog, knowledgePriceHistory } from "@/db/schema";
import { HttpError } from "@/lib/http-guard";
import type { Identity } from "./normalize";
import { toIdentity } from "./normalize";

/**
 * T-1355 — gộp sản phẩm trùng: gộp SẢN PHẨM, không gộp GIÁ.
 *
 * Nguyên tắc (phản biện GPT 2026-11-03):
 *  - Hai giá hiện hành khác nhau ⇒ KHÔNG tự chọn "mới nhất"; trả
 *    PRICE_REVIEW_REQUIRED để chủ cửa hàng quyết.
 *  - Gộp không xoá dữ liệu: item nguồn chỉ bị đánh dấu merged_into_id; ảnh và
 *    lịch sử giá chuyển sang item đích nhưng ghi lại id trong merge log.
 *  - Hoàn tác trong 24 h, dựa HOÀN TOÀN vào payload đã ghi, không suy đoán.
 */

const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PriceConflict = { source: number | null; target: number | null };

export type MergePreview = {
  ok: boolean;
  code?: "SAME_ITEM" | "NOT_FOUND" | "ALREADY_MERGED" | "PRICE_REVIEW_REQUIRED";
  message?: string;
  prices?: PriceConflict;
  counts: { images: number; duplicateImages: number; priceHistory: number };
  identity: { source: Identity; target: Identity; differs: string[] };
};

type ItemRow = {
  id: number;
  title: string;
  priceVnd: number | null;
  custom: Record<string, unknown>;
  mergedIntoId: number | null;
  deletedAt: Date | null;
};

async function loadItem(tenantId: number, id: number): Promise<ItemRow | null> {
  const [row] = await db
    .select({
      id: knowledgeItems.id,
      title: knowledgeItems.title,
      priceVnd: knowledgeItems.priceVnd,
      custom: knowledgeItems.custom,
      mergedIntoId: knowledgeItems.mergedIntoId,
      deletedAt: knowledgeItems.deletedAt,
    })
    .from(knowledgeItems)
    .where(and(eq(knowledgeItems.tenantId, tenantId), eq(knowledgeItems.id, id)))
    .limit(1);
  return row ?? null;
}

const IDENTITY_FIELDS = ["brand", "productLine", "variant", "flavor", "netQuantity", "netUnit", "packCount", "sellingUnit", "gtin"] as const;

function differs(a: Identity, b: Identity): string[] {
  return IDENTITY_FIELDS.filter((f) => a[f] !== null && b[f] !== null && a[f] !== b[f]);
}

const EMPTY_IDENTITY = { source: {} as Identity, target: {} as Identity, differs: [] as string[] };

function fail(code: NonNullable<MergePreview["code"]>, message: string): MergePreview {
  return { ok: false, code, message, counts: { images: 0, duplicateImages: 0, priceHistory: 0 }, identity: EMPTY_IDENTITY };
}

/** Xem trước: không ghi gì. Trả lý do chặn nếu có (PRICE_REVIEW_REQUIRED...). */
export async function previewMerge(tenantId: number, sourceId: number, targetId: number): Promise<MergePreview> {
  if (sourceId === targetId) return fail("SAME_ITEM", "Hai mục là một.");

  const [src, tgt] = await Promise.all([loadItem(tenantId, sourceId), loadItem(tenantId, targetId)]);
  if (!src || !tgt || src.deletedAt || tgt.deletedAt) return fail("NOT_FOUND", "Không tìm thấy mục trong cửa hàng này.");
  if (src.mergedIntoId !== null || tgt.mergedIntoId !== null) return fail("ALREADY_MERGED", "Một trong hai mục đã được gộp trước đó.");

  const imgs = await db
    .select({ id: knowledgeImages.id, assetId: knowledgeImages.assetId })
    .from(knowledgeImages)
    .where(and(eq(knowledgeImages.tenantId, tenantId), eq(knowledgeImages.itemId, sourceId), isNull(knowledgeImages.deletedAt)));
  const tgtAssets = await db
    .select({ assetId: knowledgeImages.assetId })
    .from(knowledgeImages)
    .where(and(eq(knowledgeImages.tenantId, tenantId), eq(knowledgeImages.itemId, targetId), isNull(knowledgeImages.deletedAt)));
  const tgtSet = new Set(tgtAssets.map((r) => r.assetId));
  const duplicateImages = imgs.filter((i) => tgtSet.has(i.assetId)).length;

  const [hist] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(knowledgePriceHistory)
    .where(and(eq(knowledgePriceHistory.tenantId, tenantId), eq(knowledgePriceHistory.itemId, sourceId)));

  const identity = { source: toIdentity(src.custom), target: toIdentity(tgt.custom), differs: differs(toIdentity(src.custom), toIdentity(tgt.custom)) };
  const counts = { images: imgs.length, duplicateImages, priceHistory: hist?.c ?? 0 };

  // Giá: chỉ chặn khi CẢ HAI có giá và khác nhau. Một bên null thì không mâu thuẫn.
  if (src.priceVnd !== null && tgt.priceVnd !== null && src.priceVnd !== tgt.priceVnd)
    return {
      ok: false,
      code: "PRICE_REVIEW_REQUIRED",
      message: "Hai mục có giá hiện hành khác nhau — chọn giá giữ lại trước khi gộp.",
      prices: { source: src.priceVnd, target: tgt.priceVnd },
      counts,
      identity,
    };

  return { ok: true, counts, identity };
}

export type PriceChoice = "source" | "target";

export type MergeResult = {
  logId: number;
  movedImages: number;
  skippedDuplicateImages: number;
  movedPriceHistory: number;
  priceKept: number | null;
};

/**
 * Gộp sourceId vào targetId trong MỘT transaction.
 * `priceChoice` bắt buộc khi hai bên có giá khác nhau (409 PRICE_REVIEW_REQUIRED).
 */
export async function mergeItems(opts: {
  tenantId: number;
  sourceId: number;
  targetId: number;
  actor: number | null;
  priceChoice?: PriceChoice;
}): Promise<MergeResult> {
  const { tenantId, sourceId, targetId, actor, priceChoice } = opts;
  const preview = await previewMerge(tenantId, sourceId, targetId);
  if (!preview.ok && preview.code !== "PRICE_REVIEW_REQUIRED")
    throw new HttpError(409, preview.code ?? "MERGE_BLOCKED", preview.message ?? "Không gộp được.");
  if (!preview.ok && preview.code === "PRICE_REVIEW_REQUIRED" && !priceChoice)
    throw new HttpError(
      409,
      "PRICE_REVIEW_REQUIRED",
      preview.message ?? "Cần chọn giá giữ lại.",
      `source=${preview.prices?.source ?? "null"} target=${preview.prices?.target ?? "null"}`
    );

  return db.transaction(async (tx) => {
    // Khoá cả hai dòng để hai lần gộp song song không cùng thắng.
    const locked = await tx.execute(sql`
      select id, price_vnd, custom, merged_into_id from knowledge_items
      where tenant_id = ${tenantId} and id in (${sourceId}, ${targetId}) for update
    `);
    const rows = (locked.rows ?? []) as { id: string | number; price_vnd: number | null; custom: Record<string, unknown>; merged_into_id: string | number | null }[];
    const src = rows.find((r) => Number(r.id) === sourceId);
    const tgt = rows.find((r) => Number(r.id) === targetId);
    if (!src || !tgt) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy mục.");
    if (src.merged_into_id !== null || tgt.merged_into_id !== null)
      throw new HttpError(409, "ALREADY_MERGED", "Một trong hai mục đã được gộp trước đó.");

    const srcCustom = (src.custom ?? {}) as Record<string, unknown>;
    const tgtCustom = { ...((tgt.custom ?? {}) as Record<string, unknown>) };
    // Điền trường định danh còn thiếu ở đích từ nguồn; KHÔNG ghi đè giá trị đã có.
    for (const f of IDENTITY_FIELDS) {
      if ((tgtCustom[f] === undefined || tgtCustom[f] === null || tgtCustom[f] === "") && srcCustom[f] !== undefined && srcCustom[f] !== null)
        tgtCustom[f] = srcCustom[f];
    }

    // Ảnh: chuyển những ảnh đích chưa có; ảnh trùng bị xoá mềm (giữ dấu vết).
    const srcImgs = await tx
      .select({ id: knowledgeImages.id, assetId: knowledgeImages.assetId })
      .from(knowledgeImages)
      .where(and(eq(knowledgeImages.tenantId, tenantId), eq(knowledgeImages.itemId, sourceId), isNull(knowledgeImages.deletedAt)));
    const tgtAssets = await tx
      .select({ assetId: knowledgeImages.assetId })
      .from(knowledgeImages)
      .where(and(eq(knowledgeImages.tenantId, tenantId), eq(knowledgeImages.itemId, targetId), isNull(knowledgeImages.deletedAt)));
    const tgtSet = new Set(tgtAssets.map((r) => r.assetId));
    const movedImageIds: number[] = [];
    const softDeletedImageIds: number[] = [];
    for (const img of srcImgs) {
      if (tgtSet.has(img.assetId)) {
        await tx.update(knowledgeImages).set({ deletedAt: new Date() }).where(eq(knowledgeImages.id, img.id));
        softDeletedImageIds.push(img.id);
      } else {
        await tx.update(knowledgeImages).set({ itemId: targetId }).where(eq(knowledgeImages.id, img.id));
        movedImageIds.push(img.id);
      }
    }

    // Lịch sử giá: chuyển hết (giữ provenance), không xoá dòng nào.
    const hist = await tx
      .update(knowledgePriceHistory)
      .set({ itemId: targetId })
      .where(and(eq(knowledgePriceHistory.tenantId, tenantId), eq(knowledgePriceHistory.itemId, sourceId)))
      .returning({ id: knowledgePriceHistory.id });
    const movedPriceHistoryIds = hist.map((h) => h.id);

    // Giá: chỉ đổi khi người dùng chọn; mặc định giữ giá đích (hoặc lấy giá nguồn nếu đích trống).
    let priceKept = tgt.price_vnd;
    if (src.price_vnd !== null && tgt.price_vnd === null) priceKept = src.price_vnd;
    if (priceChoice === "source" && src.price_vnd !== null) priceKept = src.price_vnd;

    await tx
      .update(knowledgeItems)
      .set({ custom: tgtCustom, priceVnd: priceKept, updatedAt: new Date() })
      .where(and(eq(knowledgeItems.tenantId, tenantId), eq(knowledgeItems.id, targetId)));

    await tx
      .update(knowledgeItems)
      .set({ mergedIntoId: targetId, mergedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(knowledgeItems.tenantId, tenantId), eq(knowledgeItems.id, sourceId)));

    const [log] = await tx
      .insert(knowledgeMergeLog)
      .values({
        tenantId,
        sourceId,
        targetId,
        createdBy: actor,
        payload: {
          movedImageIds,
          softDeletedImageIds,
          movedPriceHistoryIds,
          sourceCustom: srcCustom,
          targetCustomBefore: (tgt.custom ?? {}) as Record<string, unknown>,
          sourcePriceBefore: src.price_vnd,
          targetPriceBefore: tgt.price_vnd,
          priceChoice: priceChoice ?? null,
        },
      })
      .returning({ id: knowledgeMergeLog.id });

    return {
      logId: log.id,
      movedImages: movedImageIds.length,
      skippedDuplicateImages: softDeletedImageIds.length,
      movedPriceHistory: movedPriceHistoryIds.length,
      priceKept,
    };
  });
}

export type UndoResult = { restoredImages: number; restoredPriceHistory: number; sourceId: number; targetId: number };

/** Hoàn tác trong 24 h — dựa hoàn toàn vào payload của log. */
export async function undoMerge(opts: { tenantId: number; logId: number; actor: number | null }): Promise<UndoResult> {
  const { tenantId, logId } = opts;
  const [log] = await db
    .select()
    .from(knowledgeMergeLog)
    .where(and(eq(knowledgeMergeLog.tenantId, tenantId), eq(knowledgeMergeLog.id, logId)))
    .limit(1);
  if (!log) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy lần gộp này.");
  if (log.undoneAt) throw new HttpError(409, "ALREADY_UNDONE", "Lần gộp này đã được hoàn tác.");
  if (Date.now() - log.createdAt.getTime() > UNDO_WINDOW_MS)
    throw new HttpError(409, "UNDO_EXPIRED", "Chỉ hoàn tác được trong 24 giờ sau khi gộp.");

  const payload = (log.payload ?? {}) as {
    movedImageIds?: number[];
    softDeletedImageIds?: number[];
    movedPriceHistoryIds?: number[];
    sourceCustom?: Record<string, unknown>;
    targetCustomBefore?: Record<string, unknown>;
    targetPriceBefore?: number | null;
  };
  const sourceId = Number(log.sourceId);
  const targetId = Number(log.targetId);

  return db.transaction(async (tx) => {
    const moved = payload.movedImageIds ?? [];
    if (moved.length)
      await tx
        .update(knowledgeImages)
        .set({ itemId: sourceId })
        .where(and(eq(knowledgeImages.tenantId, tenantId), inArray(knowledgeImages.id, moved)));
    const soft = payload.softDeletedImageIds ?? [];
    if (soft.length)
      await tx
        .update(knowledgeImages)
        .set({ deletedAt: null })
        .where(and(eq(knowledgeImages.tenantId, tenantId), inArray(knowledgeImages.id, soft)));

    const hist = payload.movedPriceHistoryIds ?? [];
    if (hist.length)
      await tx
        .update(knowledgePriceHistory)
        .set({ itemId: sourceId })
        .where(and(eq(knowledgePriceHistory.tenantId, tenantId), inArray(knowledgePriceHistory.id, hist)));

    await tx
      .update(knowledgeItems)
      .set({
        custom: (payload.targetCustomBefore ?? {}) as Record<string, unknown>,
        priceVnd: payload.targetPriceBefore ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(knowledgeItems.tenantId, tenantId), eq(knowledgeItems.id, targetId)));

    await tx
      .update(knowledgeItems)
      .set({ mergedIntoId: null, mergedAt: null, updatedAt: new Date() })
      .where(and(eq(knowledgeItems.tenantId, tenantId), eq(knowledgeItems.id, sourceId)));

    await tx.update(knowledgeMergeLog).set({ undoneAt: new Date() }).where(eq(knowledgeMergeLog.id, logId));

    return { restoredImages: moved.length, restoredPriceHistory: hist.length, sourceId, targetId };
  });
}
