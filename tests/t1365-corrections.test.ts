import "dotenv/config";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { ensureDefaultTenant } from "./helpers/tenant";
import { productCorrections, productEmbeddings } from "../src/db/schema";
import { cleanupKnowledgeItems, mkKnowledgeItem } from "./helpers/knowledge";
import { correctionStats, insertCorrection, recordCorrection } from "../src/lib/retail/corrections";
import { recognizeImage } from "../src/lib/retail/recognize-service";
import { encodeImage, modelPath, resetEncoder } from "../src/lib/retail/encoder";
import { upsertEmbedding } from "../src/lib/retail/embedding-store";

/**
 * T-1365 — sửa nhận diện sai phải làm lần sau ĐÚNG, không cần train lại,
 * và lịch sử sửa không bị ghi đè.
 */

const created: number[] = [];
const assets: number[] = [];
const images: number[] = [];

async function seedAsset(buf: Buffer, tag: string): Promise<number> {
  const res = await db.execute(sql`
    insert into assets (tenant_id, kind, mime, sha256, size_bytes, origin, uploaded_by)
    values (1, 'image', 'image/jpeg', ${`t1365-${tag}`}, ${buf.length}, 'upload', 'test')
    returning id
  `);
  const id = Number((res.rows?.[0] as { id: number }).id);
  assets.push(id);
  return id;
}

before(async () => {
  await ensureDefaultTenant();
});

after(async () => {
  if (created.length) {
    const ids = sql.join(created.map((i) => sql`${i}`), sql`, `);
    await db.delete(productEmbeddings).where(sql`${productEmbeddings.itemId} in (${ids})`);
    await db.delete(productCorrections).where(sql`${productCorrections.itemId} in (${ids})`);
  }
  for (const id of images) await db.execute(sql`delete from knowledge_images where id = ${id}`);
  for (const id of assets) await db.execute(sql`delete from assets where id = ${id}`);
  await cleanupKnowledgeItems(created);
  await pool.end();
});

test("sửa 1 lần ⇒ lần nhận diện sau trả ĐÚNG SKU (không retrain)", async (t) => {
  if (!existsSync(modelPath())) {
    t.skip(`Chưa có model tại ${modelPath()}`);
    return;
  }
  resetEncoder();
  const tenantId = 1;
  const wrong = await mkKnowledgeItem(tenantId, { title: "Sai — A" });
  const right = await mkKnowledgeItem(tenantId, { title: "Đúng — B" });
  created.push(wrong, right);

  const imgWrong = await readFile("public/cams/cam1.jpg");
  const imgRight = await readFile("tests/fixtures/camera-frame.jpg");
  await upsertEmbedding({ tenantId, itemId: wrong, vec: (await encodeImage(imgWrong)).vec });

  // Trước khi sửa: index chỉ có A ⇒ ảnh của B KHÔNG được nhận đúng.
  const before1 = await recognizeImage({ tenantId, buffer: imgRight });
  assert.notEqual(before1.itemId, right, `trước khi sửa không được nhận ra B (nhận ${before1.status}/${before1.itemId})`);

  // Người dùng sửa: ảnh này là của B.
  const assetId = await seedAsset(imgRight, "right");
  const res = await recordCorrection({
    tenantId,
    itemId: right,
    predictedItemId: wrong,
    assetId,
    buffer: imgRight,
    score: before1.score,
    margin: before1.margin,
    userId: null,
  });
  images.push(res.imageId);
  assert.equal(res.embedded, true);
  assert.ok(res.correctionId > 0);

  // Sau khi sửa: cùng ảnh ⇒ đúng B, và B phải thắng A rõ ràng.
  const after1 = await recognizeImage({ tenantId, buffer: imgRight });
  assert.equal(after1.status, "MATCHED", `sau khi sửa phải MATCHED, nhận ${after1.status}/${after1.reason}`);
  assert.equal(after1.itemId, right, "sau khi sửa phải trả SKU đúng");
});

test("lịch sử sửa là append-only: sửa 2 lần ⇒ 2 dòng, không ghi đè", async () => {
  const tenantId = 1;
  const item = await mkKnowledgeItem(tenantId, { title: "Lịch sử" });
  created.push(item);
  // Dùng insertCorrection: chỉ ghi lịch sử, KHÔNG cần model ⇒ CI vẫn kiểm được
  // tính append-only dù không tải model.
  await insertCorrection({ tenantId, itemId: item, note: "lần 1", userId: null });
  await insertCorrection({ tenantId, itemId: item, note: "lần 2", userId: null });

  const rows = await db.execute(sql`select count(*)::int as n from product_corrections where tenant_id = ${tenantId} and item_id = ${item}`);
  assert.equal(Number((rows.rows?.[0] as { n: number }).n), 2, "phải giữ cả 2 lần sửa");
  const notes = await db.execute(sql`select note from product_corrections where item_id = ${item} order by id`);
  assert.deepEqual((notes.rows ?? []).map((r) => (r as { note: string }).note), ["lần 1", "lần 2"]);
});

test("không cho sửa sang SKU đã gộp hoặc SKU của tenant khác", async () => {
  const tenantId = 1;
  const item = await mkKnowledgeItem(tenantId, { title: "Hợp lệ" });
  created.push(item);
  const buf = await readFile("public/cams/cam2.jpg");

  await assert.rejects(
    () => recordCorrection({ tenantId, itemId: 999_999_999, buffer: buf, userId: null }),
    /Không tìm thấy sản phẩm|Cần assetId/,
  );
  await assert.rejects(
    () => recordCorrection({ tenantId: 2, itemId: item, buffer: buf, userId: null }),
    /Không tìm thấy sản phẩm/,
    "tenant khác không được sửa item của tenant 1",
  );
});

test("thống kê: đếm đúng số lần sửa và cặp hay nhầm", async () => {
  const stats = await correctionStats(1);
  assert.ok(stats.total >= 2, `phải có ít nhất 2 lần sửa, có ${stats.total}`);
  assert.ok(stats.byItem.length >= 1);
  assert.ok(stats.byItem.every((r) => typeof r.count === "number" && r.count > 0));
  assert.equal((await correctionStats(2)).total, 0, "tenant 2 không thấy dữ liệu của tenant 1");
});
