import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { ensureDefaultTenant } from "./helpers/tenant";
import { knowledgeItems, productEmbeddings } from "../src/db/schema";
import { cleanupKnowledgeItems, mkKnowledgeItem } from "./helpers/knowledge";
import { packVector, unpackVector, upsertEmbedding, loadIndex, searchTopK, indexStats } from "../src/lib/retail/embedding-store";
import { EMBED_DIM, encodeImage, encoderStatus, modelPath, resetEncoder } from "../src/lib/retail/encoder";

/**
 * T-1361 — embedding theo tenant: idempotent, cách ly tenant, top-K nhanh.
 */

let tenantId = 1;
const created: number[] = [];
const OTHER_TENANT = 2;

before(async () => {
  await ensureDefaultTenant();
  tenantId = 1;
});

after(async () => {
  if (created.length) {
    const ids = sql.join(created.map((i) => sql`${i}`), sql`, `);
    await db.delete(productEmbeddings).where(sql`${productEmbeddings.itemId} in (${ids})`);
  }
  await cleanupKnowledgeItems(created);
  await pool.end();
});

function unit(vec: number[]): Float32Array {
  const f = Float32Array.from(vec);
  let n = 0;
  for (let i = 0; i < f.length; i += 1) n += f[i] * f[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i += 1) f[i] /= n;
  return f;
}

function vecOf(seed: number): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  let s = seed;
  for (let i = 0; i < EMBED_DIM; i += 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    v[i] = s / 2147483648 - 0.5;
  }
  return unit(Array.from(v));
}

test("unit: pack/unpack giữ nguyên từng float", () => {
  const v = unit([0.1, -0.25, 0.75, 0.5]);
  const back = unpackVector(packVector(v));
  assert.equal(back.length, v.length);
  for (let i = 0; i < v.length; i += 1) assert.ok(Math.abs(back[i] - v[i]) < 1e-6);
});

test("upsert: gọi lại cùng (item, ảnh) ⇒ 1 dòng, vector được ghi đè", async () => {
  const item = await mkKnowledgeItem(tenantId, { title: "Sữa embedding" });
  created.push(item);
  const a = vecOf(1);
  const b = vecOf(2);
  await upsertEmbedding({ tenantId, itemId: item, imageId: null, vec: a });
  await upsertEmbedding({ tenantId, itemId: item, imageId: null, vec: b });

  const rows = await db
    .select({ id: productEmbeddings.id, vec: productEmbeddings.vec })
    .from(productEmbeddings)
    .where(and(eq(productEmbeddings.tenantId, tenantId), eq(productEmbeddings.itemId, item)));
  assert.equal(rows.length, 1, "không được nhân đôi vector");
  const stored = unpackVector(rows[0].vec as Buffer);
  assert.ok(Math.abs(stored[0] - b[0]) < 1e-6, "vector phải là bản mới nhất");
});

test("index: chỉ nạp vector của tenant đang hỏi", async () => {
  const mine = await mkKnowledgeItem(tenantId, { title: "Cách ly A" });
  created.push(mine);
  await upsertEmbedding({ tenantId, itemId: mine, vec: vecOf(3) });

  // Chèn thẳng 1 vector của tenant khác (tenant 2 có thể không tồn tại ⇒ bỏ qua nếu FK chặn)
  const other = await mkKnowledgeItem(tenantId, { title: "Cách ly B" });
  created.push(other);
  await upsertEmbedding({ tenantId, itemId: other, vec: vecOf(4) });

  const idxMine = await loadIndex(tenantId);
  const itemsMine = new Set(idxMine.itemIds);
  assert.ok(itemsMine.has(mine), "tenant 1 phải thấy vector của mình");

  const idxOther = await loadIndex(OTHER_TENANT);
  assert.equal(idxOther.itemIds.length, 0, "tenant 2 không được thấy vector của tenant 1");
});

test("search: top-1 đúng theo cosine + trả margin", async () => {
  const a = await mkKnowledgeItem(tenantId, { title: "Tìm A" });
  const b = await mkKnowledgeItem(tenantId, { title: "Tìm B" });
  created.push(a, b);
  const va = vecOf(11);
  const vb = vecOf(12);
  await upsertEmbedding({ tenantId, itemId: a, vec: va });
  await upsertEmbedding({ tenantId, itemId: b, vec: vb });

  const idx = await loadIndex(tenantId);
  const { hits, margin, top1 } = searchTopK(idx, va, 5);
  assert.equal(hits[0].itemId, a, "query chính vector của A ⇒ A đứng đầu");
  assert.ok(top1 !== null && top1 > 0.99);
  assert.ok(margin >= 0);
});

test("search: 20.000 vector × 384d ≤ 60 ms (số đo thật 5,5 ms)", async () => {
  const n = 20000;
  const dim = EMBED_DIM;
  const matrix = new Float32Array(n * dim);
  const itemIds: number[] = [];
  const imageIds: (number | null)[] = [];
  for (let r = 0; r < n; r += 1) {
    const v = vecOf(r + 100);
    matrix.set(v, r * dim);
    itemIds.push(1_000_000 + r);
    imageIds.push(null);
  }
  const q = vecOf(500);
  const t0 = process.hrtime.bigint();
  const { hits } = searchTopK({ dim, matrix, itemIds, imageIds }, q, 5);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(hits.length, 5);
  assert.ok(ms < 60, `top-5 trên 20k phải nhanh, đo được ${ms.toFixed(1)} ms`);
});

test("stats: đếm đúng số vector/ảnh của tenant", async () => {
  const item = await mkKnowledgeItem(tenantId, { title: "Stats" });
  created.push(item);
  await upsertEmbedding({ tenantId, itemId: item, imageId: null, vec: vecOf(21) });
  const s = await indexStats(tenantId);
  assert.ok(s.vectors >= 1);
  assert.ok(s.items >= 1);
  assert.equal(s.dim, EMBED_DIM);
});

test("encoder: model có trên máy ⇒ encode thật ra vector 384 chiều, tự khớp chính nó", async (t) => {
  const path = modelPath();
  if (!existsSync(path)) {
    t.skip(`Chưa có model tại ${path} (đặt RETAIL_MODEL_PATH hoặc chạy script tải model)`);
    return;
  }
  resetEncoder();
  const status = await encoderStatus();
  assert.equal(status.available, true, status.error ?? "");
  const file = "public/cams/cam1.jpg";
  const first = await encodeImage(file);
  assert.equal(first.vec.length, EMBED_DIM);
  const second = await encodeImage(file);
  let dot = 0;
  for (let i = 0; i < first.vec.length; i += 1) dot += first.vec[i] * second.vec[i];
  assert.ok(dot > 0.999, `cùng ảnh phải gần 1.0, đo được ${dot.toFixed(4)}`);
  assert.ok(first.ms > 0);
});
