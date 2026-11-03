import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { ensureDefaultTenant } from "./helpers/tenant";
import { knowledgeImages, knowledgeItems, knowledgeMergeLog, knowledgePriceHistory } from "../src/db/schema";
import { cleanupKnowledgeItems, mkAsset as mkAssetRow, mkKnowledgeItem } from "./helpers/knowledge";
import { mergeItems, previewMerge, undoMerge } from "../src/lib/knowledge/merge";

/**
 * T-1355 — gộp sản phẩm KHÔNG gộp giá, không xoá dữ liệu, hoàn tác 24 h.
 */

const GTIN = "8938505974194";
let tenantId = 1;
const createdItems: number[] = [];
const createdAssets: number[] = [];

before(async () => {
  await ensureDefaultTenant();
  tenantId = 1;
});

after(async () => {
  await cleanupKnowledgeItems(createdItems);
  await pool.end();
});

/** Wrapper mỏng: gắn tenant + theo dõi id để dọn sau test. */
async function mkItem(patch: Record<string, unknown>): Promise<number> {
  const id = await mkKnowledgeItem(tenantId, patch);
  createdItems.push(id);
  return id;
}

async function mkImage(itemId: number, assetId: number): Promise<void> {
  await db.insert(knowledgeImages).values({ tenantId, itemId, assetId });
}

async function mkPrice(itemId: number, priceVnd: number, extra: Record<string, unknown> = {}): Promise<void> {
  await db.insert(knowledgePriceHistory).values({ tenantId, itemId, priceVnd, ...extra });
}

async function mkAsset(tag: string): Promise<number> {
  const id = await mkAssetRow(tenantId, `t1355-${tag}`);
  createdAssets.push(id);
  return id;
}

/* ---------------- preview ---------------- */

test("preview: hai giá khác nhau ⇒ PRICE_REVIEW_REQUIRED kèm 2 giá, KHÔNG tự chọn", async () => {
  const a = await mkItem({ title: "Sữa A", priceVnd: 12000, custom: { gtin: GTIN } });
  const b = await mkItem({ title: "Sữa B", priceVnd: 1200, custom: { gtin: GTIN } });
  const p = await previewMerge(tenantId, a, b);
  assert.equal(p.ok, false);
  assert.equal(p.code, "PRICE_REVIEW_REQUIRED");
  assert.deepEqual(p.prices, { source: 12000, target: 1200 });
});

test("preview: cùng giá ⇒ ok, không chặn", async () => {
  const a = await mkItem({ title: "Nước mắm A", priceVnd: 35000, custom: { brand: "Nam Ngư" } });
  const b = await mkItem({ title: "Nước mắm B", priceVnd: 35000, custom: { brand: "Nam Ngư" } });
  const p = await previewMerge(tenantId, a, b);
  assert.equal(p.ok, true);
  assert.deepEqual(p.counts, { images: 0, duplicateImages: 0, priceHistory: 0 });
});

test("preview: một bên không có giá ⇒ không phải mâu thuẫn", async () => {
  const a = await mkItem({ title: "Mì A", priceVnd: 5000 });
  const b = await mkItem({ title: "Mì B" });
  const p = await previewMerge(tenantId, a, b);
  assert.equal(p.ok, true);
});

test("preview: cùng id ⇒ SAME_ITEM; id lạ ⇒ NOT_FOUND", async () => {
  const a = await mkItem({ title: "X" });
  assert.equal((await previewMerge(tenantId, a, a)).code, "SAME_ITEM");
  assert.equal((await previewMerge(tenantId, a, 99999999)).code, "NOT_FOUND");
});

/* ---------------- merge ---------------- */

test("merge: chuyển ảnh + lịch sử giá, đánh dấu nguồn, KHÔNG xoá item", async () => {
  const src = await mkItem({ title: "Cà phê nguồn", priceVnd: 60000, custom: { brand: "Trung Nguyên", flavor: "sữa đá" } });
  const tgt = await mkItem({ title: "Cà phê đích", priceVnd: 60000, custom: { brand: "Trung Nguyên" } });
  const asset1 = await mkAsset("a1");
  const asset2 = await mkAsset("a2");
  await mkImage(src, asset1);
  await mkImage(tgt, asset2);
  await mkPrice(src, 58000, { priceSource: "ocr", approvalStatus: "pending" });

  const r = await mergeItems({ tenantId, sourceId: src, targetId: tgt, actor: null });
  assert.equal(r.movedImages, 1);
  assert.equal(r.movedPriceHistory, 1);
  assert.equal(r.priceKept, 60000);

  const [s] = await db.select({ merged: knowledgeItems.mergedIntoId }).from(knowledgeItems).where(eq(knowledgeItems.id, src));
  assert.equal(Number(s.merged), tgt, "nguồn phải trỏ vào đích");

  const imgs = await db
    .select({ itemId: knowledgeImages.itemId })
    .from(knowledgeImages)
    .where(and(eq(knowledgeImages.tenantId, tenantId), eq(knowledgeImages.assetId, asset1)));
  assert.equal(Number(imgs[0].itemId), tgt, "ảnh phải chuyển sang đích");

  const hist = await db
    .select({ itemId: knowledgePriceHistory.itemId, priceSource: knowledgePriceHistory.priceSource, approval: knowledgePriceHistory.approvalStatus })
    .from(knowledgePriceHistory)
    .where(and(eq(knowledgePriceHistory.tenantId, tenantId), eq(knowledgePriceHistory.priceVnd, 58000)));
  assert.equal(Number(hist[0].itemId), tgt);
  assert.equal(hist[0].priceSource, "ocr", "provenance phải giữ nguyên khi gộp");
  assert.equal(hist[0].approval, "pending");

  const [t] = await db.select({ custom: knowledgeItems.custom }).from(knowledgeItems).where(eq(knowledgeItems.id, tgt));
  assert.equal((t.custom as Record<string, unknown>).flavor, "sữa đá", "điền trường định danh còn thiếu từ nguồn");
  assert.equal((t.custom as Record<string, unknown>).brand, "Trung Nguyên", "không ghi đè trường đã có");
});

test("merge: hai giá khác nhau, không chọn giá ⇒ 409 PRICE_REVIEW_REQUIRED và KHÔNG đổi gì", async () => {
  const src = await mkItem({ title: "Giá nguồn", priceVnd: 12000 });
  const tgt = await mkItem({ title: "Giá đích", priceVnd: 1200 });
  await assert.rejects(
    () => mergeItems({ tenantId, sourceId: src, targetId: tgt, actor: null }),
    (e: Error & { code?: string }) => e.code === "PRICE_REVIEW_REQUIRED"
  );
  const [s] = await db.select({ merged: knowledgeItems.mergedIntoId }).from(knowledgeItems).where(eq(knowledgeItems.id, src));
  assert.equal(s.merged, null, "không được đánh dấu gộp khi thiếu quyết định giá");
});

test("merge: chọn priceChoice='source' ⇒ giá đích đổi theo nguồn (đã có quyết định của người dùng)", async () => {
  const src = await mkItem({ title: "Nguồn giá", priceVnd: 12000 });
  const tgt = await mkItem({ title: "Đích giá", priceVnd: 1200 });
  const r = await mergeItems({ tenantId, sourceId: src, targetId: tgt, actor: null, priceChoice: "source" });
  assert.equal(r.priceKept, 12000);
  const [t] = await db.select({ price: knowledgeItems.priceVnd }).from(knowledgeItems).where(eq(knowledgeItems.id, tgt));
  assert.equal(t.price, 12000);
});

test("merge: ảnh trùng asset bị xoá mềm, không nhân đôi", async () => {
  const src = await mkItem({ title: "Ảnh trùng nguồn" });
  const tgt = await mkItem({ title: "Ảnh trùng đích" });
  const asset = await mkAsset("dup");
  await mkImage(src, asset);
  await mkImage(tgt, asset);
  const r = await mergeItems({ tenantId, sourceId: src, targetId: tgt, actor: null });
  assert.equal(r.movedImages, 0);
  assert.equal(r.skippedDuplicateImages, 1);
  const live = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(knowledgeImages)
    .where(and(eq(knowledgeImages.tenantId, tenantId), eq(knowledgeImages.assetId, asset), sql`${knowledgeImages.deletedAt} is null`));
  assert.equal(live[0].c, 1, "chỉ còn 1 ảnh sống cho asset đó");
});

test("merge: gộp lần hai cùng item ⇒ ALREADY_MERGED", async () => {
  const src = await mkItem({ title: "Gộp 2 lần nguồn" });
  const tgt = await mkItem({ title: "Gộp 2 lần đích" });
  await mergeItems({ tenantId, sourceId: src, targetId: tgt, actor: null });
  await assert.rejects(
    () => mergeItems({ tenantId, sourceId: src, targetId: tgt, actor: null }),
    (e: Error & { code?: string }) => e.code === "ALREADY_MERGED"
  );
});

/* ---------------- undo ---------------- */

test("undo: trả ảnh + lịch sử giá về nguồn, khôi phục giá/custom đích", async () => {
  const src = await mkItem({ title: "Undo nguồn", priceVnd: 70000, custom: { brand: "Vinamilk", flavor: "có đường" } });
  const tgt = await mkItem({ title: "Undo đích", priceVnd: 70000, custom: { brand: "Vinamilk" } });
  const asset = await mkAsset("undo1");
  await mkImage(src, asset);
  await mkPrice(src, 69000);

  const merged = await mergeItems({ tenantId, sourceId: src, targetId: tgt, actor: null });
  const undone = await undoMerge({ tenantId, logId: merged.logId, actor: null });
  assert.equal(undone.restoredImages, 1);
  assert.equal(undone.restoredPriceHistory, 1);

  const [s] = await db.select({ merged: knowledgeItems.mergedIntoId }).from(knowledgeItems).where(eq(knowledgeItems.id, src));
  assert.equal(s.merged, null, "nguồn phải được bỏ đánh dấu gộp");
  const imgs = await db
    .select({ itemId: knowledgeImages.itemId })
    .from(knowledgeImages)
    .where(and(eq(knowledgeImages.tenantId, tenantId), eq(knowledgeImages.assetId, asset), sql`${knowledgeImages.deletedAt} is null`));
  assert.equal(Number(imgs[0].itemId), src, "ảnh phải về nguồn");
  const [t] = await db.select({ custom: knowledgeItems.custom, price: knowledgeItems.priceVnd }).from(knowledgeItems).where(eq(knowledgeItems.id, tgt));
  assert.equal((t.custom as Record<string, unknown>).flavor, undefined, "custom đích phải trở lại trước khi gộp");
  assert.equal(t.price, 70000);

  const [log] = await db.select({ undoneAt: knowledgeMergeLog.undoneAt }).from(knowledgeMergeLog).where(eq(knowledgeMergeLog.id, merged.logId));
  assert.ok(log.undoneAt, "log phải được đánh dấu đã hoàn tác");
});

test("undo: lần hai ⇒ ALREADY_UNDONE; quá 24 h ⇒ UNDO_EXPIRED", async () => {
  const src = await mkItem({ title: "Undo 2 nguồn" });
  const tgt = await mkItem({ title: "Undo 2 đích" });
  const merged = await mergeItems({ tenantId, sourceId: src, targetId: tgt, actor: null });
  await undoMerge({ tenantId, logId: merged.logId, actor: null });
  await assert.rejects(
    () => undoMerge({ tenantId, logId: merged.logId, actor: null }),
    (e: Error & { code?: string }) => e.code === "ALREADY_UNDONE"
  );

  const src2 = await mkItem({ title: "Undo cũ nguồn" });
  const tgt2 = await mkItem({ title: "Undo cũ đích" });
  const merged2 = await mergeItems({ tenantId, sourceId: src2, targetId: tgt2, actor: null });
  await db.update(knowledgeMergeLog).set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(knowledgeMergeLog.id, merged2.logId));
  await assert.rejects(
    () => undoMerge({ tenantId, logId: merged2.logId, actor: null }),
    (e: Error & { code?: string }) => e.code === "UNDO_EXPIRED"
  );
});
