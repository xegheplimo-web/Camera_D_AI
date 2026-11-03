import "dotenv/config";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { ensureDefaultTenant } from "./helpers/tenant";
import { productEmbeddings } from "../src/db/schema";
import { cleanupKnowledgeItems, mkKnowledgeItem } from "./helpers/knowledge";
import { decide, type Candidate } from "../src/lib/retail/recognize";
import { minSharpness, recognizeImage, sharpness, itemByBarcode } from "../src/lib/retail/recognize-service";
import { encodeImage, modelPath, resetEncoder } from "../src/lib/retail/encoder";
import { upsertEmbedding } from "../src/lib/retail/embedding-store";

/**
 * T-1364 — bảng quyết định 5 nhánh (hàm thuần) + tích hợp DB thật.
 * Không tin "CI xanh": các assert dưới đây khẳng định đúng hành vi từ chối.
 */

const T = { abs: 0.9, margin: 0.05 };
const created: number[] = [];
const hits = (...scores: number[]): Candidate[] => scores.map((score, i) => ({ itemId: 100 + i, score }));

test("1. barcode trùng catalog ⇒ MATCHED dù visual xếp hạng khác", () => {
  const d = decide({ hits: hits(0.95, 0.94), barcode: "8938505974194", barcodeItemId: 777, thresholds: T });
  assert.equal(d.status, "MATCHED");
  assert.equal(d.reason, "BARCODE_MATCH");
  assert.equal(d.itemId, 777);
});

test("2. có barcode nhưng không tra được item ⇒ REVIEW_REQUIRED (không tự chọn)", () => {
  const d = decide({ hits: hits(0.97, 0.5), barcode: "8938505974194", barcodeItemId: null, thresholds: T });
  assert.equal(d.status, "REVIEW_REQUIRED");
  assert.equal(d.reason, "BARCODE_CONFLICT");
});

test("3. điểm cao + margin rõ ⇒ MATCHED", () => {
  const d = decide({ hits: hits(0.95, 0.8), thresholds: T });
  assert.equal(d.status, "MATCHED");
  assert.equal(d.reason, "VISUAL_CONFIDENT");
  assert.equal(d.itemId, 100);
});

test("4. điểm cao nhưng nhiều SKU giống nhau (margin nhỏ) ⇒ REVIEW_REQUIRED", () => {
  const d = decide({ hits: hits(0.9833, 0.98), thresholds: T });
  assert.equal(d.status, "REVIEW_REQUIRED");
  assert.equal(d.reason, "VISUAL_AMBIGUOUS");
});

test("5. điểm thấp ⇒ UNKNOWN", () => {
  const d = decide({ hits: hits(0.42, 0.4), thresholds: T });
  assert.equal(d.status, "UNKNOWN");
  assert.equal(d.reason, "LOW_SCORE");
});

test("6. không có vector nào ⇒ UNKNOWN, không đoán", () => {
  const d = decide({ hits: [], thresholds: T });
  assert.equal(d.status, "UNKNOWN");
  assert.equal(d.reason, "NO_INDEX");
  assert.equal(d.itemId, null);
});

test("7. ảnh không dùng được ⇒ UNKNOWN dù barcode trùng", () => {
  const d = decide({ hits: [], barcode: "8938505974194", barcodeItemId: 777, imageUsable: false, thresholds: T });
  assert.equal(d.status, "UNKNOWN");
  assert.equal(d.reason, "IMAGE_UNUSABLE");
});

test("8. chỉ một ứng viên ⇒ margin = null nhưng vẫn MATCHED nếu điểm cao", () => {
  const d = decide({ hits: hits(0.95), thresholds: T });
  assert.equal(d.status, "MATCHED");
  assert.equal(d.margin, null);
});

test("sharpness: ảnh thật > 0; ảnh trơn (1 màu) ≈ 0", async () => {
  const sharp = await import("sharp");
  const real = await sharp.default("public/cams/cam1.jpg").jpeg().toBuffer();
  const flat = await sharp.default({ create: { width: 256, height: 256, channels: 3, background: "#808080" } }).jpeg().toBuffer();
  const sReal = await sharpness(real);
  const sFlat = await sharpness(flat);
  assert.ok(sReal > 0, `ảnh thật phải có độ nét > 0, đo được ${sReal}`);
  assert.ok(sFlat < 1, `ảnh trơn phải gần 0, đo được ${sFlat}`);
  assert.ok(minSharpness() > 0);
});

test("tích hợp: ảnh đã học ⇒ MATCHED; barcode trùng ⇒ MATCHED; barcode lạ ⇒ REVIEW_REQUIRED; ảnh lạ ⇒ UNKNOWN", async (t) => {
  if (!existsSync(modelPath())) {
    t.skip(`Chưa có model tại ${modelPath()}`);
    return;
  }
  resetEncoder();
  await ensureDefaultTenant();
  const tenantId = 1;
  const itemA = await mkKnowledgeItem(tenantId, { title: "Sữa A", custom: { gtin: "8938505974194" } });
  const itemB = await mkKnowledgeItem(tenantId, { title: "Bánh B", custom: {} });
  created.push(itemA, itemB);

  // Ảnh THẬT (khác cảnh) — ảnh noise tổng hợp làm embedding bị "co" lại (cosine nền ~0,96)
  const fs = await import("node:fs/promises");
  const imgA = await fs.readFile("public/cams/cam1.jpg");
  const imgB = await fs.readFile("tests/fixtures/camera-frame.jpg");
  await upsertEmbedding({ tenantId, itemId: itemA, vec: (await encodeImage(imgA)).vec });
  await upsertEmbedding({ tenantId, itemId: itemB, vec: (await encodeImage(imgB)).vec });

  const same = await recognizeImage({ tenantId, buffer: imgA });
  assert.equal(same.status, "MATCHED", `phải khớp SKU đã học, nhận ${same.status}/${same.reason} (score ${same.score}, margin ${same.margin})`);
  assert.equal(same.itemId, itemA);
  assert.ok((same.score ?? 0) > 0.99, `cùng ảnh phải gần 1.0, đo được ${same.score}`);

  const other = await fs.readFile("tests/fixtures/camera-frame.jpg");
  const conflict = await recognizeImage({ tenantId, buffer: other, barcode: "8938505974194" });
  assert.equal(conflict.status, "MATCHED");
  assert.equal(conflict.reason, "BARCODE_MATCH", "barcode trùng phải thắng visual");
  assert.equal(conflict.itemId, itemA);

  const strayBarcode = await recognizeImage({ tenantId, buffer: other, barcode: "4006381333931" });
  assert.equal(strayBarcode.status, "REVIEW_REQUIRED");
  assert.equal(strayBarcode.reason, "BARCODE_CONFLICT");

  // Ảnh trơn/không đủ nét ⇒ KHÔNG kết luận (kể cả khi có barcode trong catalog).
  const sharpMod = (await import("sharp")).default;
  const blank = await sharpMod({ create: { width: 320, height: 320, channels: 3, background: "#808080" } }).jpeg().toBuffer();
  const unusable = await recognizeImage({ tenantId, buffer: blank, barcode: "8938505974194" });
  assert.equal(unusable.status, "UNKNOWN");
  assert.equal(unusable.reason, "IMAGE_UNUSABLE");

  // GIỚI HẠN ĐÃ BIẾT: cam3 gần như trùng cam1 (cùng kiểu gradient) ⇒ visual một mình
  // không phân biệt được; hệ thống vẫn MATCHED. Đây là lý do cần barcode làm ràng buộc cứng.
  const nearDup = await recognizeImage({ tenantId, buffer: await fs.readFile("public/cams/cam3.jpg") });
  assert.equal(nearDup.status, "MATCHED");
  assert.equal(nearDup.itemId, itemA);
});

before(async () => {
  await ensureDefaultTenant();
});

after(async () => {
  if (created.length) {
    const ids = sql.join(created.map((i) => sql`${i}`), sql`, `);
    await db.delete(productEmbeddings).where(sql`${productEmbeddings.itemId} in (${ids})`);
  }
  await cleanupKnowledgeItems(created);
  await pool.end();
});
