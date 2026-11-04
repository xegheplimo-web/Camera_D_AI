import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { ensureDefaultTenant } from "./helpers/tenant";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { db, pool } from "../src/db";
import { tenants, users, sessions, cameras, knowledgeItems, cameraProducts, auditLog } from "../src/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { ensureCameraSettings, patchCameraSettings, settingsView } from "../src/lib/knowledge/settings";

/**
 * P2 — một sản phẩm gắn được vào NHIỀU camera (bảng camera_products n-n),
 * chủ cửa hàng chủ động thiết lập; mỗi camera chỉ thấy sản phẩm của nó.
 *   - Link X→camA: GET camA trả X; GET camB trả [] TRONG KHI hàng link của A
 *     vẫn nằm trong DB ⇒ danh sách của B rỗng thật sự, không phải lọc client.
 *   - Link CÙNG X→camB: cả hai camera đều thấy X (dùng chung có chủ đích).
 *   - Unlink khỏi camA: A mất X, B còn, hàng knowledge_items X vẫn tồn tại;
 *     unlink lần hai ⇒ 404.
 *   - Tắt feature `product` của camA: camera_products + knowledge_items đều
 *     còn nguyên (tắt tính năng TUYỆT ĐỐI không xoá dữ liệu) và GET vẫn trả.
 *   - POST item thuộc tenant khác ⇒ 404, không tạo hàng; POST lặp lại là
 *     idempotent (200, không nhân đôi hàng).
 * Suite không phá huỷ: fixture tenant/user/camera/item riêng theo prefix,
 * dọn hết trong after(); server `next start` thật trên port trống.
 */
const prefix = `p2_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let app: ChildProcess, base: string;
const call: Call = makeCall(() => base);
const cookies: Record<string, string> = {};
const tenantIds: number[] = [];
const userIds: number[] = [];
const cameraIds: number[] = [];
const itemIds: number[] = [];
let tA = 0, tB = 0;
let camA = 0, camB = 0;
let itemX = 0, itemY = 0;
let logs = "";

type Linked = { linkId: number; itemId: number; title: string; sku: string | null; priceVnd: number | null };

const listLinked = (camId: number, cookie: string) => call(`/api/cameras/${camId}/products`, "GET", undefined, cookie);
const link = (camId: number, itemId: number, cookie: string) => call(`/api/cameras/${camId}/products`, "POST", { itemId }, cookie);
const unlink = (camId: number, itemId: number, cookie: string) => call(`/api/cameras/${camId}/products?itemId=${itemId}`, "DELETE", undefined, cookie);
const linkRows = (camId: number) => db.select().from(cameraProducts).where(and(eq(cameraProducts.cameraId, camId), eq(cameraProducts.tenantId, tA)));

before(async () => {
  // Fixture cần production build cho `next start` — build một lần nếu chưa có.
  if (!existsSync(".next/BUILD_ID")) {
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit" });
    assert.equal(r.status, 0, "next build thất bại (fixture cần `next start`)");
  }

  await ensureDefaultTenant();
  const t = await db
    .insert(tenants)
    .values([{ slug: `${prefix}-a`, name: `${prefix} A` }, { slug: `${prefix}-b`, name: `${prefix} B` }])
    .returning({ id: tenants.id });
  [tA, tB] = t.map((x) => x.id);
  tenantIds.push(tA, tB);

  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  const us = await db
    .insert(users)
    .values([
      { login: `${prefix}_owner_a`, displayName: `${prefix}_owner_a`, role: "owner", passwordHash, tenantId: tA },
      { login: `${prefix}_owner_b`, displayName: `${prefix}_owner_b`, role: "owner", passwordHash, tenantId: tB },
    ])
    .returning({ id: users.id });
  userIds.push(...us.map((u) => u.id));

  // Hai camera cùng tenant A — chứng minh link là per-camera, không phải per-tenant.
  const cams = await db
    .insert(cameras)
    .values([
      { tenantId: tA, code: `${prefix}_a`, name: `${prefix} Cam A`, location: "loc-a" },
      { tenantId: tA, code: `${prefix}_b`, name: `${prefix} Cam B`, location: "loc-b" },
    ])
    .returning({ id: cameras.id });
  [camA, camB] = cams.map((c) => c.id);
  cameraIds.push(camA, camB);

  // X thuộc tenant A (sản phẩm dùng chung), Y thuộc tenant B (không được gắn/trả lộ).
  const items = await db
    .insert(knowledgeItems)
    .values([
      { tenantId: tA, scope: "workspace", title: `${prefix} Sữa tươi`, sku: "ST-01", priceVnd: 25000, note: "sản phẩm dùng chung" },
      { tenantId: tB, scope: "workspace", title: `${prefix} Hàng tenant B`, sku: "TB-99", priceVnd: 99000 },
    ])
    .returning({ id: knowledgeItems.id });
  [itemX, itemY] = items.map((i) => Number(i.id));
  itemIds.push(itemX, itemY);

  const appPort = await freePort();
  base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], {
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {}
    await wait(100);
  }
  assert.ok(ready, logs);
  for (const who of ["owner_a", "owner_b"]) cookies[who] = await loginUser(call, prefix, password, who);
}, { timeout: 300000 });

after(async () => {
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  const ids = [...cameraIds.map(String), ...itemIds.map(String), ...userIds.map(String)];
  await db.delete(auditLog).where(and(inArray(auditLog.action, ["camera.product_link", "camera.product_unlink", "scope.denied", "auth.login", "auth.logout"]), inArray(auditLog.targetId, ids)));
  if (tenantIds.length) await db.delete(cameraProducts).where(inArray(cameraProducts.tenantId, tenantIds));
  if (itemIds.length) await db.delete(knowledgeItems).where(inArray(knowledgeItems.id, itemIds));
  if (cameraIds.length) await db.delete(cameras).where(inArray(cameras.id, cameraIds));
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  await pool.end();
}, { timeout: 20000 });

test("p2(a): link X→camA — GET A trả X; GET B rỗng dù hàng link tồn tại (lọc phía server)", async () => {
  const r = await link(camA, itemX, cookies.owner_a);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const a = await listLinked(camA, cookies.owner_a);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const aRows = a.data as Linked[];
  assert.ok(Array.isArray(aRows), "GET phải trả mảng sản phẩm của camera");
  const hit = aRows.find((p) => p.itemId === itemX);
  assert.ok(hit, "GET camA phải trả sản phẩm X vừa gắn");
  assert.equal(hit.title, `${prefix} Sữa tươi`);
  assert.equal(hit.sku, "ST-01");
  assert.equal(hit.priceVnd, 25000);

  // Chứng minh KHÔNG lọc phía client: hàng link của A vẫn nằm trong DB…
  const rowsA = await linkRows(camA);
  assert.equal(rowsA.length, 1, "DB phải có đúng 1 hàng link cho camA");
  assert.equal(Number(rowsA[0].itemId), itemX);
  assert.equal(rowsA[0].tenantId, tA);
  // …nhưng GET của camB vẫn trả rỗng — server tự lọc theo camera_id của B.
  const b = await listLinked(camB, cookies.owner_a);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.deepEqual(b.data, [], "camB không được thấy sản phẩm đã link cho camA (không rò rỉ chéo camera)");

  // Idempotent: POST lặp cùng item ⇒ 200 (không phải 500), vẫn đúng 1 hàng.
  const dup = await link(camA, itemX, cookies.owner_a);
  assert.equal(dup.status, 200, `link lặp phải trả 200, nhận ${dup.status}: ${JSON.stringify(dup.data)}`);
  assert.equal((await linkRows(camA)).length, 1, "link lặp không được nhân đôi hàng camera_products");
});

test("p2(b): link CÙNG X→camB — cả hai camera đều thấy X (dùng chung có chủ đích)", async () => {
  const r = await link(camB, itemX, cookies.owner_a);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const a = (await listLinked(camA, cookies.owner_a)).data as Linked[];
  const b = (await listLinked(camB, cookies.owner_a)).data as Linked[];
  assert.ok(a.some((p) => p.itemId === itemX), "camA vẫn thấy X");
  assert.ok(b.some((p) => p.itemId === itemX), "camB cũng thấy X — cùng một sản phẩm trên nhiều camera");
  assert.equal(
    (await db.select({ id: cameraProducts.id }).from(cameraProducts).where(eq(cameraProducts.itemId, itemX))).length,
    2,
    "cùng item phải có 2 hàng link (mỗi camera một)",
  );
});

test("p2(c): unlink X khỏi camA — A mất X, B còn, hàng knowledge_items X vẫn tồn tại", async () => {
  const r = await unlink(camA, itemX, cookies.owner_a);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const a = (await listLinked(camA, cookies.owner_a)).data as Linked[];
  assert.ok(!a.some((p) => p.itemId === itemX), "camA không còn thấy X");
  const b = (await listLinked(camB, cookies.owner_a)).data as Linked[];
  assert.ok(b.some((p) => p.itemId === itemX), "camB vẫn thấy X — gỡ khỏi A không ảnh hưởng B");

  const [x] = await db.select({ id: knowledgeItems.id }).from(knowledgeItems).where(eq(knowledgeItems.id, itemX));
  assert.ok(x, "gỡ link không được xoá hàng knowledge_items");

  // Unlink lần hai ⇒ 404 (không còn link để gỡ).
  const again = await unlink(camA, itemX, cookies.owner_a);
  assert.equal(again.status, 404, `unlink link không tồn tại phải 404, nhận ${again.status}`);
});

test("p2(d): tắt feature product của camA — camera_products + knowledge_items vẫn còn (tắt ≠ xoá)", async () => {
  // Gắn lại X→camA để có dữ liệu kiểm chứng trước khi tắt.
  const r = await link(camA, itemX, cookies.owner_a);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const row = await ensureCameraSettings(tA, camA);
  assert.ok(row);
  const on = await patchCameraSettings(tA, camA, { revision: row.revision, features: { ...row.features, product: true } });
  assert.ok(on.ok);
  assert.equal(settingsView(on.row).featureFlags.product, true);

  const off = await patchCameraSettings(tA, camA, {
    revision: on.row.revision,
    features: { ...on.row.features, product: false },
  });
  assert.ok(off.ok);
  assert.equal(settingsView(off.row).featureFlags.product, false);

  // Tắt feature chỉ giấu UI — không được xoá link lẫn item.
  const links = await linkRows(camA);
  assert.equal(links.length, 1, "hàng camera_products phải còn nguyên sau khi tắt product");
  const [x] = await db.select({ id: knowledgeItems.id }).from(knowledgeItems).where(eq(knowledgeItems.id, itemX));
  assert.ok(x, "hàng knowledge_items phải còn nguyên sau khi tắt product");
  const a = (await listLinked(camA, cookies.owner_a)).data as Linked[];
  assert.ok(a.some((p) => p.itemId === itemX), "GET vẫn trả sản phẩm đã link — tắt feature không gỡ link");
});

test("p2(e): POST item của tenant khác ⇒ 404, không tạo hàng; item/camera chéo tenant cũng 404", async () => {
  // owner_a cố gắn item của tenant B vào camera của mình.
  const r = await link(camA, itemY, cookies.owner_a);
  assert.equal(r.status, 404, `item tenant khác phải 404, nhận ${r.status}: ${JSON.stringify(r.data)}`);
  const leaked = await db.select({ id: cameraProducts.id }).from(cameraProducts).where(eq(cameraProducts.itemId, itemY));
  assert.equal(leaked.length, 0, "không được tạo hàng link cho item ngoài tenant");

  // owner_b cố gắn item của chính mình vào camera tenant A — camera chéo tenant.
  const r2 = await link(camA, itemY, cookies.owner_b);
  assert.equal(r2.status, 404, `camera tenant khác phải 404, nhận ${r2.status}`);
  assert.equal((await db.select({ id: cameraProducts.id }).from(cameraProducts).where(eq(cameraProducts.itemId, itemY))).length, 0);
});

test("p2(f): DELETE link không tồn tại ⇒ 404; thiếu/sai itemId ⇒ 400; camera không tồn tại ⇒ 404", async () => {
  // itemY chưa link vào camA (bị chặn ở p2e) ⇒ unlink phải 404.
  const r = await unlink(camA, itemY, cookies.owner_a);
  assert.equal(r.status, 404, `gỡ link không tồn tại phải 404, nhận ${r.status}`);

  const bad = await call(`/api/cameras/${camA}/products`, "DELETE", undefined, cookies.owner_a);
  assert.equal(bad.status, 400, `DELETE thiếu itemId phải 400, nhận ${bad.status}`);

  const ghost = await listLinked(99999999, cookies.owner_a);
  assert.equal(ghost.status, 404, `camera không tồn tại/khác tenant phải 404, nhận ${ghost.status}`);
});
