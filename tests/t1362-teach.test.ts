import "dotenv/config";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db, pool } from "../src/db";
import { ensureDefaultTenant } from "./helpers/tenant";
import { productEmbeddings } from "../src/db/schema";
import { cleanupKnowledgeItems, mkKnowledgeItem } from "./helpers/knowledge";
import { updateImage, updateItem } from "../src/lib/knowledge/items";
import { embedStatus, upsertEmbedding } from "../src/lib/retail/embedding-store";
import { encodeImage, modelPath } from "../src/lib/retail/encoder";
import { existsSync } from "node:fs";

/**
 * T-1362 — "Dạy AI nhận diện" ở mức dữ liệu:
 *  - trạng thái học của SKU (0 ảnh học / sẵn sàng),
 *  - ảnh khách KHÔNG tự vào thư viện chung (shareToLibrary mặc định false, chỉ bật khi chủ động),
 *  - mã vạch lưu đã chuẩn hoá, mã sai bị từ chối.
 */

const created: number[] = [];
const assets: number[] = [];
const images: number[] = [];

async function seedAsset(tag: string): Promise<number> {
  const buf = await readFile("public/cams/cam1.jpg");
  const res = await db.execute(sql`
    insert into assets (tenant_id, kind, mime, sha256, size_bytes, origin, uploaded_by)
    values (1, 'image', 'image/jpeg', ${`t1362-${tag}`}, ${buf.length}, 'upload', 'test')
    returning id
  `);
  const id = Number((res.rows?.[0] as { id: number }).id);
  assets.push(id);
  return id;
}

async function attachImage(itemId: number, tag: string): Promise<number> {
  const assetId = await seedAsset(tag);
  const res = await db.execute(sql`
    insert into knowledge_images (tenant_id, item_id, asset_id)
    values (1, ${itemId}, ${assetId}) returning id
  `);
  const id = Number((res.rows?.[0] as { id: number }).id);
  images.push(id);
  return id;
}

before(async () => {
  await ensureDefaultTenant();
});

after(async () => {
  if (created.length) {
    const ids = sql.join(created.map((i) => sql`${i}`), sql`, `);
    await db.delete(productEmbeddings).where(sql`${productEmbeddings.itemId} in (${ids})`);
  }
  for (const id of images) await db.execute(sql`delete from knowledge_images where id = ${id}`);
  for (const id of assets) await db.execute(sql`delete from assets where id = ${id}`);
  await cleanupKnowledgeItems(created);
  await pool.end();
});

test("trạng thái học: chưa có vector ⇒ chưa sẵn sàng; có 1 vector ⇒ sẵn sàng", async (t) => {
  const item = await mkKnowledgeItem(1, { title: "Dạy AI — trạng thái" });
  created.push(item);
  const img1 = await attachImage(item, "st1");
  await attachImage(item, "st2");

  const before = await embedStatus(1, item);
  assert.deepEqual({ images: before.images, embedded: before.embedded, ready: before.ready }, { images: 2, embedded: 0, ready: false });

  if (!existsSync(modelPath())) {
    // Không có model (CI): kiểm nhánh "đã có vector" bằng vector tổng hợp — cùng bảng, cùng truy vấn.
    await upsertEmbedding({ tenantId: 1, itemId: item, imageId: img1, vec: new Float32Array(384).fill(0.1) });
  } else {
    const { vec } = await encodeImage(await readFile("public/cams/cam1.jpg"));
    await upsertEmbedding({ tenantId: 1, itemId: item, imageId: img1, vec });
  }

  const after1 = await embedStatus(1, item);
  assert.equal(after1.embedded, 1);
  assert.equal(after1.ready, true);
  t.diagnostic(`images=${after1.images} embedded=${after1.embedded}`);
});

test("ảnh khách mặc định KHÔNG chia sẻ; chỉ bật khi chủ động, và phải là boolean", async () => {
  const item = await mkKnowledgeItem(1, { title: "Dạy AI — chia sẻ" });
  created.push(item);
  const imgId = await attachImage(item, "share");

  const [row] = (await db.execute(sql`select share_to_library from knowledge_images where id = ${imgId}`)).rows as {
    share_to_library: boolean;
  }[];
  assert.equal(row.share_to_library, false, "mặc định phải là false");

  const on = await updateImage(1, imgId, { shareToLibrary: true });
  assert.equal(on.shareToLibrary, true);
  const off = await updateImage(1, imgId, { shareToLibrary: false });
  assert.equal(off.shareToLibrary, false);

  await assert.rejects(() => updateImage(1, imgId, { shareToLibrary: "yes" }), /shareToLibrary/);
});

test("mã vạch: giữ dạng người dùng nhập, nhưng EAN-13 và GTIN-14 là CÙNG định danh", async () => {
  const item = await mkKnowledgeItem(1, { title: "Dạy AI — mã vạch" });
  created.push(item);

  const row = await updateItem(1, item, { gtin: "8938505974194" });
  const c1 = row.custom as { gtin?: string; identityFingerprint?: string };
  assert.equal(c1.gtin, "8938505974194", "không tự đổi dạng người dùng nhập");

  // Cùng một mã, viết 14 số ⇒ fingerprint KHÔNG đổi (nếu đổi thì mọi quyết định gộp sẽ sai).
  const row2 = await updateItem(1, item, { gtin: "08938505974194" });
  const c2 = row2.custom as { identityFingerprint?: string; identityRevision?: number };
  assert.equal(c2.identityFingerprint, c1.identityFingerprint, "EAN-13 và GTIN-14 phải cùng fingerprint");
  assert.equal(c2.identityRevision, (row.custom as { identityRevision?: number }).identityRevision, "không được coi là đổi định danh");

  await assert.rejects(() => updateItem(1, item, { gtin: "khong-phai-ma" }), /gtin|mã vạch/i);
});
