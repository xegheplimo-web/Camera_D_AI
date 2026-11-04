import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { db, pool } from "../src/db";
import { tenants, cameras, cameraSettings, assets } from "../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import { CAMERA_FEATURES, normalizeFeatures } from "../src/lib/camera/features";
import { ensureCameraSettings, patchCameraSettings, settingsView } from "../src/lib/knowledge/settings";

/**
 * P1 — cấu hình tính năng theo TỪNG camera.
 *   - normalizeFeatures (thuần): `{}` ⇒ watch bật, còn lại tắt; `{motion:true}`
 *     ⇒ motion bật + phần còn lại mặc định; input lỗi (null/mảng/chuỗi/số) ⇒
 *     mặc định không ném; khoá lạ (cờ tương lai) được giữ nguyên.
 *   - Cô lập per-camera: A bật {motion:true}, B để {} ⇒ đọc settings mỗi
 *     camera trả map riêng — B không bao giờ thấy cờ của A.
 *   - Tắt tính năng KHÔNG xoá dữ liệu: bật product, chèn asset ảnh gắn camera
 *     + tham chiếu ảnh trong features, rồi tắt product ⇒ asset vẫn còn (assert
 *     theo id) và hàng settings vẫn giữ tham chiếu ảnh.
 * Suite không phá huỷ: fixture tenant/camera/asset riêng theo prefix, dọn
 * hết trong after(); camera_settings tự cascade theo cameras.
 */
const prefix = `p1_${randomBytes(5).toString("hex")}`;
let tenantId = 0;
let camA = 0, camB = 0, camC = 0;
const cameraIds: number[] = [];
const assetIds: number[] = [];

before(async () => {
  const [t] = await db.insert(tenants).values({ slug: `${prefix}-t`, name: `${prefix} T` }).returning({ id: tenants.id });
  tenantId = t.id;
  const cams = await db
    .insert(cameras)
    .values([
      { tenantId, code: `${prefix}_a`, name: `${prefix} A`, location: "loc-a" },
      { tenantId, code: `${prefix}_b`, name: `${prefix} B`, location: "loc-b" },
      { tenantId, code: `${prefix}_c`, name: `${prefix} C`, location: "loc-c" },
    ])
    .returning({ id: cameras.id });
  [camA, camB, camC] = cams.map((c) => c.id);
  cameraIds.push(camA, camB, camC);
});

after(async () => {
  if (assetIds.length) await db.delete(assets).where(inArray(assets.id, assetIds));
  if (cameraIds.length) await db.delete(cameras).where(inArray(cameras.id, cameraIds)); // cascade → camera_settings
  if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

test("p1(a): normalizeFeatures — object rỗng ⇒ watch bật, mọi cờ khác tắt", () => {
  const f = normalizeFeatures({});
  for (const feat of CAMERA_FEATURES) {
    assert.equal(f[feat.id], feat.id === "watch", `${feat.id} phải mặc định ${feat.id === "watch" ? "bật" : "tắt"}`);
  }
});

test("p1(b): normalizeFeatures — {motion:true} ⇒ motion bật, phần còn lại giữ mặc định", () => {
  const f = normalizeFeatures({ motion: true });
  assert.equal(f.watch, true, "watch luôn mặc định bật");
  assert.equal(f.motion, true);
  for (const feat of CAMERA_FEATURES) {
    if (feat.id !== "watch" && feat.id !== "motion") assert.equal(f[feat.id], false, `${feat.id} phải tắt`);
  }
});

test("p1(c): normalizeFeatures — input lỗi ⇒ mặc định, không ném", () => {
  for (const bad of [null, [], "x", 7]) {
    const f = normalizeFeatures(bad);
    assert.equal(f.watch, true, `watch phải mặc định bật với input ${JSON.stringify(bad)}`);
    assert.equal(f.motion, false);
    assert.equal(f.product, false);
    assert.equal(f.record, false);
  }
});

test("p1(d): normalizeFeatures — khoá lạ (cờ tương lai) được giữ, không bị rơi mất", () => {
  const f = normalizeFeatures({ futureFlag: true, motion: true }) as Record<string, unknown>;
  assert.equal(f.futureFlag, true, "khoá chưa biết phải sống sót qua normalize");
  assert.equal(f.motion, true);
});

test("p1(e): cô lập per-camera — A bật motion, B mặc định ⇒ mỗi camera một map riêng", async () => {
  const rowA = await ensureCameraSettings(tenantId, camA);
  const rowB = await ensureCameraSettings(tenantId, camB);
  assert.ok(rowA && rowB);

  const patched = await patchCameraSettings(tenantId, camA, {
    revision: rowA.revision,
    features: { ...rowA.features, motion: true },
  });
  assert.ok(patched.ok);

  const viewA = settingsView(patched.row);
  const freshB = await ensureCameraSettings(tenantId, camB);
  assert.ok(freshB);
  const viewB = settingsView(freshB);

  assert.equal(viewA.featureFlags.motion, true, "camera A phải thấy motion bật");
  assert.equal(viewB.featureFlags.motion, false, "camera B không được thấy cờ motion của camera A");
  assert.equal(viewA.featureFlags.watch, true);
  assert.equal(viewB.featureFlags.watch, true);
  assert.equal(viewB.featureFlags.product, false);
});

test("p1(f): tắt product KHÔNG xoá dữ liệu — asset + tham chiếu ảnh trong settings còn nguyên", async () => {
  const row = await ensureCameraSettings(tenantId, camC);
  assert.ok(row);
  const on = await patchCameraSettings(tenantId, camC, {
    revision: row.revision,
    features: { ...row.features, product: true },
  });
  assert.ok(on.ok);
  assert.equal(settingsView(on.row).featureFlags.product, true);

  // Asset ảnh thuộc camera + tham chiếu lưu trong features của hàng settings.
  const [asset] = await db
    .insert(assets)
    .values({ tenantId, cameraId: camC, kind: "image", mime: "image/png", sha256: randomBytes(32).toString("hex"), origin: "upload" })
    .returning({ id: assets.id });
  assetIds.push(asset.id);
  const linked = await patchCameraSettings(tenantId, camC, {
    revision: on.row.revision,
    features: { ...on.row.features, productImageId: asset.id },
  });
  assert.ok(linked.ok);

  // Tắt product = giấu khỏi UI — dữ liệu đã lưu phải còn nguyên.
  const off = await patchCameraSettings(tenantId, camC, {
    revision: linked.row.revision,
    features: { ...linked.row.features, product: false },
  });
  assert.ok(off.ok);
  assert.equal(settingsView(off.row).featureFlags.product, false);

  const [still] = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, asset.id));
  assert.ok(still, "asset ảnh phải còn sau khi tắt product (tắt ≠ xoá)");
  const [st] = await db
    .select({ features: cameraSettings.features })
    .from(cameraSettings)
    .where(eq(cameraSettings.cameraId, camC));
  assert.equal(st.features.productImageId, asset.id, "hàng settings vẫn giữ tham chiếu ảnh");
  assert.equal(st.features.product, false);
});
