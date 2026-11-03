import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { ensureDefaultTenant } from "./helpers/tenant";
import { knowledgeItems, knowledgePairDecisions } from "../src/db/schema";
import { cleanupKnowledgeItems, itemSide, mkKnowledgeItem } from "./helpers/knowledge";
import { decisionOf, findDuplicatePairs, keepSeparate, pairFingerprint, pairKey } from "../src/lib/knowledge/pairs";
import { toIdentity } from "../src/lib/knowledge/normalize";

/**
 * T-1356 — "Giữ riêng" theo cặp: không bắc cầu, hết hiệu lực khi định danh đổi.
 */

const GTIN = "8938505974194";
let tenantId = 1;
const created: number[] = [];

before(async () => {
  await ensureDefaultTenant();
  tenantId = 1;
});

after(async () => {
  await cleanupKnowledgeItems(created);
  await pool.end();
});

/** Wrapper mỏng: gắn tenant + theo dõi id để dọn sau test. */
async function mkItem(patch: Record<string, unknown>): Promise<number> {
  const id = await mkKnowledgeItem(tenantId, patch);
  created.push(id);
  return id;
}

const sideOf = (id: number) => itemSide(tenantId, id);

/* ---------------- unit ---------------- */

test("unit: pairKey chuẩn hoá thứ tự (a,b) và (b,a) như nhau", () => {
  assert.deepEqual(pairKey(9, 4), { lo: 4, hi: 9, key: "4:9" });
  assert.equal(pairKey(4, 9).key, pairKey(9, 4).key);
});

test("unit: vân tay đổi khi trường định danh đổi", () => {
  const a = { id: 1, title: "Sữa", identity: toIdentity({ gtin: GTIN, netQuantity: 1000, netUnit: "ml" }) };
  const b = { id: 2, title: "Sữa 2", identity: toIdentity({ gtin: GTIN, netQuantity: 1000, netUnit: "ml" }) };
  const before = pairFingerprint(a, b);
  const changed = pairFingerprint(a, { ...b, identity: toIdentity({ gtin: GTIN, netQuantity: 500, netUnit: "ml" }) });
  assert.notEqual(before, changed);
});

/* ---------------- integration ---------------- */

test("keepSeparate: ghi được quyết định, đọc lại đúng vân tay", async () => {
  const a = await mkItem({ title: "Nước ngọt A", custom: { gtin: GTIN, netQuantity: 330 } });
  const b = await mkItem({ title: "Nước ngọt B", custom: { gtin: GTIN, netQuantity: 330 } });
  const res = await keepSeparate({ tenantId, a: await sideOf(a), b: await sideOf(b), actor: null });
  assert.equal(res.key, pairKey(a, b).key);
  assert.equal(await decisionOf(tenantId, a, b), res.fingerprint);
  assert.equal(await decisionOf(tenantId, b, a), res.fingerprint, "tra ngược thứ tự vẫn ra");
});

test("keepSeparate: gọi lại không tạo bản ghi thứ hai (idempotent)", async () => {
  const a = await mkItem({ title: "Bánh A", custom: { gtin: GTIN } });
  const b = await mkItem({ title: "Bánh B", custom: { gtin: GTIN } });
  await keepSeparate({ tenantId, a: await sideOf(a), b: await sideOf(b), actor: null });
  await keepSeparate({ tenantId, a: await sideOf(a), b: await sideOf(b), actor: null });
  const [cnt] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(knowledgePairDecisions)
    .where(
      and(
        eq(knowledgePairDecisions.tenantId, tenantId),
        eq(knowledgePairDecisions.minItemId, Math.min(a, b)),
        eq(knowledgePairDecisions.maxItemId, Math.max(a, b))
      )
    );
  assert.equal(cnt.c, 1);
});

test("findDuplicatePairs: cặp đã 'giữ riêng' không còn hiện, nhưng cặp khác vẫn hiện", async () => {
  const a = await mkItem({ title: "Mì gói A", custom: { gtin: GTIN, netQuantity: 75 } });
  const b = await mkItem({ title: "Mì gói B", custom: { gtin: GTIN, netQuantity: 75 } });
  const c = await mkItem({ title: "Mì gói C", custom: { gtin: GTIN, netQuantity: 75 } });

  const before = await findDuplicatePairs(tenantId, {});
  const keysBefore = before.pairs.map((p) => p.key);
  assert.ok(keysBefore.includes(pairKey(a, b).key), "trước khi quyết định, cặp phải hiện");

  await keepSeparate({ tenantId, a: await sideOf(a), b: await sideOf(b), actor: null });

  const afterRes = await findDuplicatePairs(tenantId, {});
  const keysAfter = afterRes.pairs.map((p) => p.key);
  assert.ok(!keysAfter.includes(pairKey(a, b).key), "cặp đã giữ riêng phải bị ẩn");
  assert.ok(keysAfter.includes(pairKey(a, c).key), "KHÔNG bắc cầu: cặp a-c vẫn phải hiện");
  assert.ok(afterRes.counts.decidedHidden >= 1);
});

test("findDuplicatePairs: định danh đổi ⇒ quyết định cũ hết hiệu lực, cặp hiện lại", async () => {
  const a = await mkItem({ title: "Trà A", custom: { gtin: GTIN, netQuantity: 500, netUnit: "ml" } });
  const b = await mkItem({ title: "Trà B", custom: { gtin: GTIN, netQuantity: 500, netUnit: "ml" } });
  await keepSeparate({ tenantId, a: await sideOf(a), b: await sideOf(b), actor: null });
  assert.ok(!(await findDuplicatePairs(tenantId, {})).pairs.some((p) => p.key === pairKey(a, b).key));

  // đổi dung tích của B ⇒ vân tay đổi
  await db
    .update(knowledgeItems)
    .set({ custom: { gtin: GTIN, netQuantity: 250, netUnit: "ml" } })
    .where(eq(knowledgeItems.id, b));

  const after = await findDuplicatePairs(tenantId, {});
  assert.ok(after.pairs.some((p) => p.key === pairKey(a, b).key), "cặp phải hiện lại để người dùng xem lại");
});

test("findDuplicatePairs: biến thể khác nhau bị ẩn và đếm riêng, không lẫn vào 'cần xem'", async () => {
  const a = await mkItem({ title: "Sữa tắm A", custom: { brand: "Lifebuoy", netQuantity: 850, netUnit: "ml" } });
  const b = await mkItem({ title: "Sữa tắm B", custom: { brand: "Lifebuoy", netQuantity: 1700, netUnit: "ml" } });
  const res = await findDuplicatePairs(tenantId, {});
  assert.ok(!res.pairs.some((p) => p.key === pairKey(a, b).key));
  assert.ok(res.counts.variantsHidden >= 1);
});

test("findDuplicatePairs: item đã gộp (merged_into_id) không tham gia rà soát", async () => {
  const a = await mkItem({ title: "Kẹo A", custom: { gtin: GTIN } });
  const b = await mkItem({ title: "Kẹo B", custom: { gtin: GTIN } });
  await db.update(knowledgeItems).set({ mergedIntoId: b }).where(eq(knowledgeItems.id, a));
  const res = await findDuplicatePairs(tenantId, {});
  assert.ok(!res.pairs.some((p) => p.key === pairKey(a, b).key));
  await db.update(knowledgeItems).set({ mergedIntoId: null }).where(eq(knowledgeItems.id, a));
});
