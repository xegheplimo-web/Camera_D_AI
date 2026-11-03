import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { ensureDefaultTenant } from "./helpers/tenant";
import { knowledgeItems } from "../src/db/schema";
import { classifyPair, findCandidates } from "../src/lib/knowledge/duplicates";
import { toIdentity } from "../src/lib/knowledge/normalize";

/**
 * T-1350A — chỉ tìm ứng viên, không ghi.
 * Quy tắc: ràng buộc định danh quyết định trước, similarity chỉ xếp hạng.
 */

const GTIN_A = "8938505974194"; // EAN-13 hợp lệ
const GTIN_B = "8935049500018"; // EAN-13 hợp lệ khác

let tenantId = 1;
const created: number[] = [];

before(async () => {
  await ensureDefaultTenant();
  tenantId = 1; // helper bảo đảm tenant mặc định id=1 tồn tại
});

after(async () => {
  if (created.length)
    await db.delete(knowledgeItems).where(sql`${knowledgeItems.id} in (${sql.join(created.map((i) => sql`${i}`), sql`, `)})`);
  await pool.end();
});

async function mkItem(patch: Record<string, unknown>): Promise<number> {
  const [row] = await db
    .insert(knowledgeItems)
    .values({
      tenantId,
      scope: "camera",
      title: String(patch.title ?? "Sản phẩm"),
      priceVnd: typeof patch.priceVnd === "number" ? patch.priceVnd : null,
      custom: (patch.custom ?? {}) as Record<string, unknown>,
    })
    .returning({ id: knowledgeItems.id });
  created.push(row.id);
  return row.id;
}

/* ---------------- unit: classifyPair ---------------- */

test("unit: GTIN trùng + cùng đơn vị bán ⇒ EXACT_CANDIDATE", () => {
  const a = toIdentity({ gtin: GTIN_A, brand: "TH", netQuantity: "180 ml", sellingUnit: "hộp" });
  const b = toIdentity({ gtin: GTIN_A, brand: "TH", netQuantity: "180 ml", sellingUnit: "hộp" });
  const r = classifyPair(a, b);
  assert.equal(r.class, "EXACT_CANDIDATE");
  assert.deepEqual(r.reasons, ["gtin_equal"]);
});

test("unit: GTIN trùng nhưng đơn vị bán khác (chai vs lốc) ⇒ DIFFERENT_VARIANT", () => {
  const a = toIdentity({ gtin: GTIN_A, sellingUnit: "chai" });
  const b = toIdentity({ gtin: GTIN_A, sellingUnit: "lốc" });
  const r = classifyPair(a, b);
  assert.equal(r.class, "DIFFERENT_VARIANT");
  assert.ok(r.reasons.includes("gtin_equal_but_selling_unit_differs"));
});

test("unit: GTIN khác nhau ⇒ REVIEW_REQUIRED (không tự gộp)", () => {
  const a = toIdentity({ gtin: GTIN_A, brand: "TH" });
  const b = toIdentity({ gtin: GTIN_B, brand: "TH" });
  assert.equal(classifyPair(a, b).class, "REVIEW_REQUIRED");
});

test("unit: khác vị (cá cơm vs cá hồi) ⇒ DIFFERENT_VARIANT, không phải trùng", () => {
  const a = toIdentity({ brand: "Nam Ngư", flavor: "cá cơm", netQuantity: "500 ml" });
  const b = toIdentity({ brand: "Nam Ngư", flavor: "cá hồi", netQuantity: "500 ml" });
  const r = classifyPair(a, b);
  assert.equal(r.class, "DIFFERENT_VARIANT");
  assert.ok(r.reasons.includes("flavor_differs"));
});

test("unit: không GTIN nhưng khoá định danh trùng ⇒ LIKELY_DUPLICATE", () => {
  const a = toIdentity({ brand: "TH", flavor: "ít đường", netQuantity: "180 ml", sellingUnit: "hộp" });
  const b = toIdentity({ brand: "TH", flavor: "ít đường", netQuantity: "0,18 l", sellingUnit: "hộp" });
  assert.equal(classifyPair(a, b).class, "LIKELY_DUPLICATE");
});

test("unit: thiếu trường định danh ⇒ REVIEW_REQUIRED, không đoán", () => {
  const a = toIdentity({ brand: "TH" });
  const b = toIdentity({ brand: "TH", flavor: "ít đường", netQuantity: "180 ml" });
  assert.equal(classifyPair(a, b).class, "REVIEW_REQUIRED");
});

/* ---------------- integration: findCandidates ---------------- */

test("integration: tìm theo GTIN trùng, và KHÔNG ghi thêm bản ghi nào", async () => {
  const id = await mkItem({ title: "Sữa TH 180ml", priceVnd: 7000, custom: { gtin: GTIN_A, brand: "TH", netQuantity: 180, netUnit: "ml", sellingUnit: "hộp" } });

  const before = await db.select({ c: sql<number>`count(*)::int` }).from(knowledgeItems).where(eq(knowledgeItems.tenantId, tenantId));
  const res = await findCandidates(tenantId, { title: "Sữa TH 180ml", gtin: GTIN_A, brand: "TH", netQuantity: "180 ml", sellingUnit: "hộp" });
  const after = await db.select({ c: sql<number>`count(*)::int` }).from(knowledgeItems).where(eq(knowledgeItems.tenantId, tenantId));

  assert.equal(res.class, "EXACT_CANDIDATE");
  assert.ok(res.candidates.some((c) => c.id === id && c.class === "EXACT_CANDIDATE"));
  assert.equal(after[0].c, before[0].c, "findCandidates không được ghi dữ liệu");
});

test("integration: biến thể khác dung tích bị xếp DIFFERENT_VARIANT", async () => {
  const id = await mkItem({ title: "Sữa TH 1 lít", custom: { brand: "TH", flavor: "ít đường", netQuantity: 1000, netUnit: "ml" } });
  const res = await findCandidates(tenantId, { title: "Sữa TH 180ml", brand: "TH", flavor: "ít đường", netQuantity: "180 ml" });
  const hit = res.candidates.find((c) => c.id === id);
  assert.ok(hit, "phải thấy ứng viên cùng brand");
  assert.equal(hit.class, "DIFFERENT_VARIANT");
});

test("integration: draft không có brand/GTIN và title lạ ⇒ không trả ứng viên", async () => {
  const res = await findCandidates(tenantId, { title: "Máy khoan Bosch GSB 550" });
  assert.equal(res.class, "UNKNOWN");
  assert.deepEqual(res.candidates, []);
});
