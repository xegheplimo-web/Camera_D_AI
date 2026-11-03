import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { db, pool } from "../src/db";
import {
  users, tenants, cameras, assets, sessions, auditLog,
  knowledgeItems, cameraSettings,
} from "../src/db/schema";
import { eq, inArray, like, or } from "drizzle-orm";

/**
 * T-1335 — camera settings (revision) + knowledge base (items/images/price history).
 * Fixture: tenant mặc định (owner/operator/viewer) + tenant thứ 2 (owner riêng,
 * camera riêng, item riêng) để chứng minh lọc tenant + 404 không lộ sự tồn tại.
 * Server: `next start` thật trên port trống; dữ liệu test dọn sạch trong after().
 */
const prefix = `t1335_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let app: ChildProcess, base: string;
const call: Call = makeCall(() => base);
const cookies: Record<string, string> = {};
const userIds: number[] = [];
const itemIds: number[] = [];
let t2id = 0, camA = 0, camB = 0, camC = 0, a1 = 0, a2 = 0, a3 = 0, t2asset = 0, t2ItemId = 0;
let logs = "";

const owner = () => cookies.owner;
const operator = () => cookies.operator;
const viewer = () => cookies.viewer;
const t2owner = () => cookies.t2owner;
async function login(who: string) {
  cookies[who] = await loginUser(call, prefix, password, who);
}
async function newItem(body: Record<string, unknown>, cookie = owner()) {
  const r = await call("/api/knowledge/items", "POST", body, cookie);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  itemIds.push(r.data.id);
  return r.data;
}

before(async () => {
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  const [t2] = await db.insert(tenants).values({ slug: `${prefix}-t2`, name: `${prefix} tenant 2` }).returning();
  t2id = t2.id;
  const inserted = await db.insert(users).values([
    { login: `${prefix}_owner`, displayName: `${prefix}_owner`, role: "owner", passwordHash },
    { login: `${prefix}_operator`, displayName: `${prefix}_operator`, role: "operator", passwordHash },
    { login: `${prefix}_viewer`, displayName: `${prefix}_viewer`, role: "viewer", passwordHash },
    { login: `${prefix}_t2owner`, displayName: `${prefix}_t2owner`, role: "owner", passwordHash, tenantId: t2id },
  ]).returning();
  userIds.push(...inserted.map((u) => u.id));

  const [ca] = await db.insert(cameras).values({ code: `${prefix}-a`, name: `${prefix} cam A`, location: "Fixture", sourceType: "demo", status: "demo" }).returning();
  const [cb] = await db.insert(cameras).values({ code: `${prefix}-b`, name: `${prefix} cam B`, location: "Fixture", sourceType: "demo", status: "demo" }).returning();
  const [cc] = await db.insert(cameras).values({ code: `${prefix}-c`, name: `${prefix} cam C (t2)`, location: "Fixture", sourceType: "demo", status: "demo", tenantId: t2id }).returning();
  camA = ca.id; camB = cb.id; camC = cc.id;

  const assetRows = await db.insert(assets).values([
    { kind: "image", mime: "image/jpeg", sha256: `${prefix}-a1`, origin: "capture", cameraId: camA },
    { kind: "image", mime: "image/jpeg", sha256: `${prefix}-a2`, origin: "capture", cameraId: camA },
    { kind: "image", mime: "image/jpeg", sha256: `${prefix}-a3`, origin: "capture", cameraId: camA },
    { kind: "image", mime: "image/jpeg", sha256: `${prefix}-t2`, origin: "capture", cameraId: camC, tenantId: t2id },
  ]).returning();
  [a1, a2, a3, t2asset] = assetRows.map((r) => r.id);

  const [t2Item] = await db.insert(knowledgeItems).values({ tenantId: t2id, title: `${prefix} t2 item`, scope: "workspace", createdBy: inserted[3].id }).returning();
  t2ItemId = t2Item.id; itemIds.push(t2ItemId);

  const appPort = await freePort(); base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  for (const who of ["owner", "operator", "viewer", "t2owner"]) await login(who);
}, { timeout: 60000 });

after(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  // Xoá items trước: cascade dọn images + price history; tenant RESTRICT yêu cầu không còn tham chiếu.
  await db.delete(knowledgeItems).where(or(inArray(knowledgeItems.id, itemIds.length ? itemIds : [-1]), like(knowledgeItems.title, `${prefix}%`), eq(knowledgeItems.tenantId, t2id)));
  if (camA || camB || camC) await db.delete(cameras).where(inArray(cameras.id, [camA, camB, camC].filter(Boolean))); // camera_settings cascade
  const assetIds = [a1, a2, a3, t2asset].filter(Boolean);
  if (assetIds.length) await db.delete(assets).where(inArray(assets.id, assetIds));
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
  if (t2id) await db.delete(tenants).where(eq(tenants.id, t2id));
  await pool.end();
}, { timeout: 20000 });

/* ================= 1. Camera settings + revision ================= */

test("PATCH settings camera A không đổi camera B; revision cũ ⇒ 409, revision mới ⇒ 200", async () => {
  const a0 = await call(`/api/cameras/${camA}/settings`, "GET", undefined, owner());
  assert.equal(a0.status, 200, JSON.stringify(a0.data));
  assert.equal(a0.data.revision, 1);
  assert.equal(a0.data.profile, "custom");
  assert.equal(a0.data.retentionDays, 7);
  assert.equal(a0.data.recordEnabled, false);
  // T-1340: record phản ánh mediaMTX thật ⇒ boolean tuỳ môi trường; pricing vẫn luôn khoá phase này.
  assert.equal(typeof a0.data.capabilities.record, "boolean");
  assert.equal(a0.data.capabilities.pricing, false);

  const p1 = await call(`/api/cameras/${camA}/settings`, "PATCH", { revision: 1, profile: "warehouse", retentionDays: 14, detectFps: 10 }, owner());
  assert.equal(p1.status, 200, JSON.stringify(p1.data));
  assert.equal(p1.data.revision, 2);
  assert.equal(p1.data.profile, "warehouse");
  assert.equal(p1.data.retentionDays, 14);
  assert.equal(p1.data.recordEnabled, false, "payload không đụng recordEnabled ⇒ cờ giữ nguyên");
  assert.equal(typeof p1.data.capabilities.record, "boolean");

  const b0 = await call(`/api/cameras/${camB}/settings`, "GET", undefined, owner());
  assert.equal(b0.status, 200);
  assert.equal(b0.data.revision, 1, "camera B không bị PATCH A ảnh hưởng");
  assert.equal(b0.data.retentionDays, 7);
  assert.equal(b0.data.profile, "custom");

  const stale = await call(`/api/cameras/${camA}/settings`, "PATCH", { revision: 1, detectFps: 20 }, owner());
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal(stale.data.currentRevision, 2);
  assert.equal(stale.data.settings.retentionDays, 14);
  assert.equal(stale.data.settings.detectFps, 10);

  const p2 = await call(`/api/cameras/${camA}/settings`, "PATCH", { revision: 2, detectFps: 20 }, operator());
  assert.equal(p2.status, 200, JSON.stringify(p2.data));
  assert.equal(p2.data.revision, 3);
  assert.equal(p2.data.detectFps, 20);

  assert.equal((await call(`/api/cameras/${camA}/settings`, "PATCH", { detectFps: 9 }, owner())).status, 400, "thiếu revision ⇒ 400");
});

test("PATCH recordEnabled trên camera chưa có nguồn RTSP ⇒ 400 fail-closed, record_enabled không đổi", async () => {
  const g = await call(`/api/cameras/${camB}/settings`, "GET", undefined, owner());
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal(g.data.recordEnabled, false);

  const r = await call(`/api/cameras/${camB}/settings`, "PATCH", { revision: g.data.revision, recordEnabled: true }, owner());
  assert.equal(r.status, 400, JSON.stringify(r.data));
  assert.equal(r.data.detail, "record_requires_rtsp", "bị chặn trước khi gọi recorder ⇒ độc lập mediaMTX");

  const [row] = await db.select({ recordEnabled: cameraSettings.recordEnabled }).from(cameraSettings).where(eq(cameraSettings.cameraId, camB));
  assert.equal(row?.recordEnabled, false, "persist() không chạy ⇒ record_enabled trong DB đứng yên, không báo bật giả");
});

/* ================= 2. Item + nhiều ảnh, mỗi ảnh note riêng ================= */

test("tạo mục + 3 ảnh note riêng; đọc lại đúng note từng ảnh", async () => {
  const item = await newItem({ scope: "camera", cameraId: camA, title: `${prefix} mục 3 ảnh`, sku: "SKU-01", note: "ghi chú mục" });
  const notes: [number, string][] = [[a1, "ảnh mặt trước"], [a2, "ảnh mặt sau"], [a3, "ảnh tem nhãn"]];
  for (const [assetId, note] of notes) {
    const r = await call(`/api/knowledge/items/${item.id}/images`, "POST", { assetId, note }, owner());
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.assetId, assetId);
    assert.equal(r.data.note, note);
  }
  const g = await call(`/api/knowledge/items/${item.id}`, "GET", undefined, viewer()); // viewer vẫn đọc
  assert.equal(g.status, 200, JSON.stringify(g.data));
  assert.equal(g.data.title, `${prefix} mục 3 ảnh`);
  assert.equal(g.data.images.length, 3);
  const byAsset = new Map<number, string>(g.data.images.map((im: any) => [im.assetId, im.note]));
  for (const [assetId, note] of notes) assert.equal(byAsset.get(assetId), note);
});

/* ================= 3. Cùng asset ở nhiều item ================= */

test("cùng asset_id gắn 2 mục ⇒ 2 dòng, 2 note, không lỗi unique", async () => {
  const i1 = await newItem({ title: `${prefix} mục X` });
  const i2 = await newItem({ title: `${prefix} mục Y` });
  const r1 = await call(`/api/knowledge/items/${i1.id}/images`, "POST", { assetId: a1, note: "note của X" }, owner());
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  const r2 = await call(`/api/knowledge/items/${i2.id}/images`, "POST", { assetId: a1, note: "note của Y" }, owner());
  assert.equal(r2.status, 201, JSON.stringify(r2.data));
  assert.notEqual(r1.data.id, r2.data.id, "hai dòng knowledge_images khác nhau");

  const [g1, g2] = await Promise.all([
    call(`/api/knowledge/items/${i1.id}`, "GET", undefined, owner()),
    call(`/api/knowledge/items/${i2.id}`, "GET", undefined, owner()),
  ]);
  assert.equal(g1.data.images.find((im: any) => im.assetId === a1)?.note, "note của X");
  assert.equal(g2.data.images.find((im: any) => im.assetId === a1)?.note, "note của Y");
});

/* ================= 4. Giá + lịch sử giá ================= */

test("đổi giá 2 lần ⇒ price_vnd mới nhất + 2 dòng history đúng thứ tự", async () => {
  const item = await newItem({ title: `${prefix} mục giá`, priceVnd: 50000 });
  const p1 = await call(`/api/knowledge/items/${item.id}/price`, "POST", { priceVnd: 150000 }, owner());
  assert.equal(p1.status, 200, JSON.stringify(p1.data));
  assert.equal(p1.data.priceVnd, 150000);
  const p2 = await call(`/api/knowledge/items/${item.id}/price`, "POST", { priceVnd: 99000 }, operator());
  assert.equal(p2.status, 200, JSON.stringify(p2.data));
  assert.equal(p2.data.priceVnd, 99000);

  const g = await call(`/api/knowledge/items/${item.id}`, "GET", undefined, owner());
  assert.equal(g.status, 200);
  assert.equal(g.data.priceVnd, 99000, "giá chuẩn = lần đổi mới nhất");
  const hist = (g.data.priceHistory as any[]).map((h) => h.priceVnd);
  assert.deepEqual(hist, [50000, 150000, 99000], "history theo thứ tự thời gian, gồm giá khởi tạo");

  assert.equal((await call(`/api/knowledge/items/${item.id}/price`, "POST", { priceVnd: -1000 }, owner())).status, 400, "giá âm bị từ chối");
  assert.equal((await call(`/api/knowledge/items/${item.id}/price`, "POST", { priceVnd: 12.5 }, owner())).status, 400, "giá float bị từ chối");
});

/* ================= 5. Negative: 401 / 403 / 404 ================= */

test("401 không phiên · 403 viewer ghi · 404 id tenant khác hoặc không tồn tại", async () => {
  const item = await newItem({ title: `${prefix} mục negative` });
  const img = await call(`/api/knowledge/items/${item.id}/images`, "POST", { assetId: a2, note: "x" }, owner());
  assert.equal(img.status, 201, JSON.stringify(img.data));

  for (const r of [
    await call("/api/knowledge/items", "GET", undefined, ""),
    await call("/api/knowledge/items", "POST", { title: "x" }, ""),
    await call(`/api/knowledge/items/${item.id}`, "GET", undefined, ""),
    await call(`/api/cameras/${camA}/settings`, "GET", undefined, ""),
  ]) assert.equal(r.status, 401, JSON.stringify(r.data));

  const v = viewer();
  for (const r of [
    await call("/api/knowledge/items", "POST", { title: "x" }, v),
    await call(`/api/knowledge/items/${item.id}`, "PATCH", { title: "x" }, v),
    await call(`/api/knowledge/items/${item.id}`, "DELETE", undefined, v),
    await call(`/api/knowledge/items/${item.id}/images`, "POST", { assetId: a1 }, v),
    await call(`/api/knowledge/items/${item.id}/price`, "POST", { priceVnd: 1000 }, v),
    await call(`/api/knowledge/images/${img.data.id}`, "PATCH", { note: "x" }, v),
    await call(`/api/cameras/${camA}/settings`, "PATCH", { revision: 1, detectFps: 1 }, v),
  ]) assert.equal(r.status, 403, JSON.stringify(r.data));

  // Khác tenant: 404 đồng nhất cả hai chiều, không lộ sự tồn tại.
  for (const r of [
    await call(`/api/knowledge/items/${t2ItemId}`, "GET", undefined, owner()),
    await call(`/api/knowledge/items/${t2ItemId}`, "PATCH", { title: "x" }, owner()),
    await call(`/api/knowledge/items/${t2ItemId}`, "DELETE", undefined, owner()),
    await call(`/api/knowledge/items/${t2ItemId}/price`, "POST", { priceVnd: 1 }, owner()),
    await call(`/api/knowledge/items/${item.id}`, "GET", undefined, t2owner()),
    await call(`/api/cameras/${camC}/settings`, "GET", undefined, owner()),
    await call(`/api/cameras/${camA}/settings`, "GET", undefined, t2owner()),
    await call("/api/knowledge/items/99999999", "GET", undefined, owner()),
  ]) assert.equal(r.status, 404, JSON.stringify(r.data));

  // List tenant 2 thấy item của mình, không thấy item tenant 1; gắn asset tenant khác ⇒ 404.
  const l2 = await call("/api/knowledge/items", "GET", undefined, t2owner());
  assert.equal(l2.status, 200);
  assert.ok(l2.data.some((i: any) => i.id === t2ItemId), "tenant 2 thấy item của chính mình");
  assert.ok(!l2.data.some((i: any) => i.id === item.id), "tenant 2 không thấy item tenant 1");
  const cross = await call(`/api/knowledge/items/${item.id}/images`, "POST", { assetId: t2asset, note: "x" }, owner());
  assert.equal(cross.status, 404, "asset tenant khác ⇒ 404");
});

/* ================= 6. Soft delete ================= */

test("soft delete: mục biến khỏi GET list + GET item 404; assets không bị xoá", async () => {
  const item = await newItem({ title: `${prefix} mục xoá mềm` });
  const img = await call(`/api/knowledge/items/${item.id}/images`, "POST", { assetId: a3, note: "giữ asset" }, owner());
  assert.equal(img.status, 201, JSON.stringify(img.data));

  const del = await call(`/api/knowledge/items/${item.id}`, "DELETE", undefined, owner());
  assert.equal(del.status, 200, JSON.stringify(del.data));

  const list = await call("/api/knowledge/items", "GET", undefined, owner());
  assert.equal(list.status, 200);
  assert.ok(!list.data.some((i: any) => i.id === item.id), "mục đã xoá không xuất hiện trong list");
  assert.equal((await call(`/api/knowledge/items/${item.id}`, "GET", undefined, owner())).status, 404, "GET item đã xoá ⇒ 404");

  const [assetRow] = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, a3));
  assert.ok(assetRow, "asset vẫn còn trong bảng assets sau soft delete");
});
