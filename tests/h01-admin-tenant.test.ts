import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { ensureDefaultTenant, assertDestructiveTestDb } from "./helpers/tenant";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { db, pool } from "../src/db";
import { tenants, users, sessions, cameras, events, assets, extractions, messages, auditLog } from "../src/db/schema";
import { and, eq, inArray, like, ne, sql } from "drizzle-orm";

/**
 * H-01c — /api/admin phải scope theo tenant của session (tenantIdOf → users.tenant_id).
 * Repro: route đọc/ghi toàn cục (mọi db.* không lọc tenant) — owner tenant A đọc được
 * stats/sessions/audit của tenant B và reset_all xoá trắng mọi tenant.
 * Suite này dựng:
 *   - tenant 2 "canary": camera/event/asset/extraction/audit + phiên đăng nhập có marker
 *     duy nhất ⇒ owner tenant 1 GET /api/admin không được thấy (stats khớp đúng số liệu
 *     tenant 1 trong DB, sessions/logs không lẫn actor tenant 2).
 *   - tenant 3 "resetter": owner của nó gọi reset_all ⇒ chỉ dữ liệu tenant 3 mất; đếm
 *     trước/sau của tenant 1 lẫn tenant 2 không đổi. Tenant riêng thay vì tenant 1 để test
 *     không phá dữ liệu dev — cùng một đường code, chứng minh cách ly tương đương.
 * Negative: operator POST ⇒ 403 như hiện tại; reset_all thiếu confirmPhrase ⇒ 400.
 */
const prefix = `h01c_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let app: ChildProcess, base: string;
const call: Call = makeCall(() => base);
const cookies: Record<string, string> = {};
const userIds: number[] = [];
const tenantIds: number[] = [];
const camIds: number[] = [];
const assetIds: number[] = [];
let logs = "";
let t2 = 0, t3 = 0;
const T2_NAME = `${prefix}_owner_t2`;
const T3_NAME = `${prefix}_owner_t3`;

async function rows(tenant: number, table: any, extra?: any): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(table)
    .where(and(eq(table.tenantId, tenant), ...(extra ? [extra] : [])));
  return r.c;
}

async function login(who: string) {
  cookies[who] = await loginUser(call, prefix, password, who);
}

before(async () => {
  assertDestructiveTestDb();
  // Fixture cần production build cho `next start` — build một lần nếu chưa có.
  if (!existsSync(".next/BUILD_ID")) {
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit" });
    assert.equal(r.status, 0, "next build thất bại (fixture cần `next start`)");
  }

  await ensureDefaultTenant();
  const t = await db.insert(tenants).values([{ slug: `${prefix}-t2`, name: `${prefix} t2` }, { slug: `${prefix}-t3`, name: `${prefix} t3` }]).returning();
  t2 = t[0].id; t3 = t[1].id;
  tenantIds.push(t2, t3);

  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  const inserted = await db
    .insert(users)
    .values([
      { login: `${prefix}_owner_t1`, displayName: `${prefix}_owner_t1`, role: "owner", passwordHash, tenantId: 1 },
      { login: `${prefix}_owner_t2`, displayName: T2_NAME, role: "owner", passwordHash, tenantId: t2 },
      { login: `${prefix}_owner_t3`, displayName: T3_NAME, role: "owner", passwordHash, tenantId: t3 },
      { login: `${prefix}_oper_t1`, displayName: `${prefix}_oper_t1`, role: "operator", passwordHash, tenantId: 1 },
    ])
    .returning();
  userIds.push(...inserted.map((u) => u.id));
  const owner3 = inserted.find((u) => u.login === `${prefix}_owner_t3`)!;

  // Canary tenant 2 — mọi marker chứa "CANARY" để assert vắng mặt trong response tenant 1.
  const [cam2] = await db.insert(cameras).values({ tenantId: t2, code: `${prefix}-C2`, name: `${prefix}_CANARY_CAM`, location: `${prefix}_CANARY_LOC`, sourceType: "demo", status: "demo" }).returning();
  camIds.push(cam2.id);
  const a2 = await db
    .insert(assets)
    .values([
      { tenantId: t2, kind: "image", mime: "image/jpeg", sha256: `${prefix}_CANARY_SHA`, url: `/canary/${prefix}.jpg`, sizeBytes: 424243, origin: "upload", cameraId: cam2.id },
      { tenantId: t2, kind: "image", mime: "image/jpeg", sha256: `${prefix}_CANARY_SHA_DEMO`, url: `/canary/${prefix}-demo.jpg`, sizeBytes: 11, origin: "demo", cameraId: cam2.id },
    ])
    .returning();
  assetIds.push(...a2.map((a) => a.id));
  await db.insert(events).values([
    { tenantId: t2, cameraId: cam2.id, type: "person_in", label: `${prefix}_CANARY_LIVE`, source: "live", clientReported: false },
    { tenantId: t2, cameraId: cam2.id, type: "person_in", label: `${prefix}_CANARY_DEMO`, source: "demo", clientReported: false },
  ]);
  await db.insert(extractions).values({ tenantId: t2, assetId: a2[1].id, note: `${prefix}_CANARY extraction`, source: "demo" });
  await db.insert(auditLog).values({ actor: T2_NAME, actorRole: "owner", action: `${prefix}.canary.action`, detail: `${prefix}_CANARY audit` });

  // Dữ liệu riêng của tenant 3 — reset_all của tenant 3 phải xoá đúng phần này.
  const [cam3] = await db.insert(cameras).values({ tenantId: t3, code: `${prefix}-C3`, name: `${prefix}_T3_CAM`, location: "t3", sourceType: "demo", status: "demo" }).returning();
  camIds.push(cam3.id);
  const [a3] = await db.insert(assets).values({ tenantId: t3, kind: "image", mime: "image/jpeg", sha256: `${prefix}_T3_SHA`, url: `/t3/${prefix}.jpg`, sizeBytes: 7, origin: "upload", cameraId: cam3.id }).returning();
  assetIds.push(a3.id);
  await db.insert(extractions).values({ tenantId: t3, assetId: a3.id, note: `${prefix}_T3 extraction`, source: "live" });
  await db.insert(events).values({ tenantId: t3, cameraId: cam3.id, type: "manual", label: `${prefix}_T3 event`, source: "manual", clientReported: false });
  await db.insert(messages).values({ tenantId: t3, role: "user", text: `${prefix}_T3 message`, userId: owner3.id, device: "test" });

  const appPort = await freePort(); base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  for (const who of ["owner_t1", "owner_t2", "owner_t3", "oper_t1"]) await login(who);
}, { timeout: 300000 });

after(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  if (assetIds.length) await db.delete(extractions).where(inArray(extractions.assetId, assetIds));
  if (camIds.length) await db.delete(events).where(inArray(events.cameraId, camIds));
  if (assetIds.length) await db.delete(assets).where(inArray(assets.id, assetIds));
  if (camIds.length) await db.delete(cameras).where(inArray(cameras.id, camIds));
  if (userIds.length) {
    await db.delete(messages).where(inArray(messages.userId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
  await pool.end();
}, { timeout: 20000 });

test("GET /api/admin của owner tenant 1 không lộ dữ liệu canary tenant 2", async () => {
  const r = await call("/api/admin", "GET", undefined, cookies.owner_t1);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const j = JSON.stringify(r.data);
  assert.ok(!j.includes("CANARY"), "response chứa marker tenant 2");
  assert.ok(!j.includes(T2_NAME), "sessions/logs lộ actor tenant 2");

  // Số liệu trả về phải khớp đúng phần tenant 1 trong DB (canary tenant 2 không được tính).
  assert.equal(r.data.liveEvents, await rows(1, events, ne(events.source, "demo")));
  assert.equal(r.data.demoEvents, await rows(1, events, eq(events.source, "demo")));
  assert.equal(r.data.demo.extractions, await rows(1, extractions, eq(extractions.source, "demo")));
  assert.equal(r.data.demo.assets, await rows(1, assets, eq(assets.origin, "demo")));
  const [st] = await db.select({ b: sql<number>`coalesce(sum(${assets.sizeBytes}),0)::bigint` }).from(assets).where(eq(assets.tenantId, 1));
  assert.equal(r.data.storageBytes, Number(st.b));
});

test("operator gọi /api/admin: GET giữ quyền đọc tenant mình, POST vẫn 403 như hiện tại", async () => {
  const g = await call("/api/admin", "GET", undefined, cookies.oper_t1);
  assert.equal(g.status, 200, "operator có manage — hành vi hiện tại phải giữ");
  assert.ok(!JSON.stringify(g.data).includes("CANARY"), "operator tenant 1 vẫn thấy canary tenant 2");
  const p = await call("/api/admin", "POST", { action: "reset_all", confirmPhrase: "XOA DU LIEU" }, cookies.oper_t1);
  assert.equal(p.status, 403);
});

test("reset_all thiếu confirmPhrase ⇒ 400", async () => {
  const p = await call("/api/admin", "POST", { action: "reset_all" }, cookies.owner_t3);
  assert.equal(p.status, 400);
});

test("reset_all của owner tenant 3 chỉ xoá tenant 3 — tenant 1 & 2 nguyên vẹn", async () => {
  const before = {
    t1: { ev: await rows(1, events), ex: await rows(1, extractions), as: await rows(1, assets), ca: await rows(1, cameras), ms: await rows(1, messages) },
    t2: { ev: await rows(t2, events), ex: await rows(t2, extractions), as: await rows(t2, assets), ca: await rows(t2, cameras), ms: await rows(t2, messages) },
  };

  const p = await call("/api/admin", "POST", { action: "reset_all", confirmPhrase: "XOA DU LIEU" }, cookies.owner_t3);
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.ok, true);
  assert.equal(p.data.demoReseeded, false, "reseed chỉ dành cho tenant mặc định");

  // Tenant 3 mất sạch fixture của chính nó — chứng minh xoá thật, không phải no-op.
  assert.equal(await rows(t3, events), 0);
  assert.equal(await rows(t3, extractions), 0);
  assert.equal(await rows(t3, assets), 0);
  assert.equal(await rows(t3, cameras), 0);
  assert.equal(await rows(t3, messages), 0);

  // Tenant 1 và tenant 2 đếm lại y hệt trước reset.
  for (const [label, before_, t] of [["t1", before.t1, 1], ["t2", before.t2, t2]] as const) {
    const after_ = { ev: await rows(t, events), ex: await rows(t, extractions), as: await rows(t, assets), ca: await rows(t, cameras), ms: await rows(t, messages) };
    assert.deepEqual(after_, before_, `reset_all tenant 3 đụng vào ${label}`);
  }

  // Audit log của hành động tenant 3 cũng không lọt vào màn admin tenant 1.
  const g = await call("/api/admin", "GET", undefined, cookies.owner_t1);
  assert.ok(!JSON.stringify(g.data).includes(T3_NAME), "audit/actor tenant 3 lọt vào logs tenant 1");
});
