import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { ensureDefaultTenant } from "./helpers/tenant";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { db, pool } from "../src/db";
import { tenants, users, sessions, cameras, events, alertRules, auditLog } from "../src/db/schema";
import { and, eq, gte, inArray, like } from "drizzle-orm";

/**
 * H-01 — /api/alerts phải scoped theo tenant trên CẢ 5 đường:
 *   GET (events + cameras + rules + counts), POST {all:true}, POST {ids:[]},
 *   PUT toggle/delete, PUT create.
 *
 * RED trên HEAD trước bản vá: GET trả event/camera/rule của tenant B;
 * {all:true} ack chéo tenant; {ids:[idB]} IDOR; toggle/delete rule B được;
 * create của tenant B rơi về tenant_id = 1 (default).
 *
 * Suite không phá huỷ dữ liệu dev: fixture riêng theo prefix + dọn sạch sau.
 */
const prefix = `h01al_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let app: ChildProcess, base: string;
const call: Call = makeCall(() => base);
const cookies: Record<string, string> = {};
const userIds: number[] = [];
const tenantIds: number[] = [];
let tA = 0, tB = 0;
let camA = 0, camB = 0;
let evA = 0, evB = 0;
let ruleA = 0, ruleB = 0;
const camBName = `${prefix}_camB`;
let logs = "";
let suiteStartedAt = new Date(0); // set once in before()

before(async () => {
  suiteStartedAt = new Date(Date.now() - 60_000);
  // Fixture cần production build cho `next start`. CI build sẵn → SKIP_BUILD=1 để khỏi build lần 2.
  // Node 20+ từ chối spawn `npm.cmd` khi thiếu shell:true (CVE-2024-27980) → gọi thẳng next build.
  if (!(process.env.SKIP_BUILD === "1" && existsSync(".next/BUILD_ID"))) {
    const r = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], { stdio: "inherit", cwd: process.cwd() });
    assert.equal(r.status, 0, "next build thất bại (fixture cần `next start`)");
  }

  await ensureDefaultTenant();
  const t = await db.insert(tenants).values([{ slug: `${prefix}-a`, name: `${prefix} A` }, { slug: `${prefix}-b`, name: `${prefix} B` }]).returning();
  tA = t[0].id; tB = t[1].id;
  tenantIds.push(tA, tB);

  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  const inserted = await db
    .insert(users)
    .values([
      { login: `${prefix}_owner_a`, displayName: `${prefix}_owner_a`, role: "owner", passwordHash, tenantId: tA },
      { login: `${prefix}_owner_b`, displayName: `${prefix}_owner_b`, role: "owner", passwordHash, tenantId: tB },
    ])
    .returning();
  userIds.push(...inserted.map((u) => u.id));

  const cams = await db.insert(cameras).values([
    { tenantId: tA, code: `${prefix}_camA`, name: `${prefix}_camA`, location: "A-site" },
    { tenantId: tB, code: `${prefix}_camB`, name: camBName, location: "B-secret-site" },
  ]).returning({ id: cameras.id });
  camA = cams[0].id; camB = cams[1].id;

  const evs = await db.insert(events).values([
    { tenantId: tA, cameraId: camA, type: "alert", label: `${prefix}_evA`, priority: "critical", source: "live" },
    { tenantId: tB, cameraId: camB, type: "alert", label: `${prefix}_evB`, priority: "critical", source: "live" },
  ]).returning({ id: events.id });
  evA = evs[0].id; evB = evs[1].id;

  const rules = await db.insert(alertRules).values([
    { tenantId: tA, name: `${prefix}_ruleA`, type: "alert", priority: "important", createdBy: `${prefix}_owner_a` },
    { tenantId: tB, name: `${prefix}_ruleB`, type: "alert", priority: "important", createdBy: `${prefix}_owner_b` },
  ]).returning({ id: alertRules.id });
  ruleA = rules[0].id; ruleB = rules[1].id;

  const appPort = await freePort(); base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  for (const who of ["owner_a", "owner_b"]) cookies[who] = await loginUser(call, prefix, password, who);
}, { timeout: 300000 });

after(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  // Xoá theo tenant + theo prefix (bắt cả rule bị create nhầm vào tenant 1).
  await db.delete(alertRules).where(inArray(alertRules.tenantId, tenantIds));
  await db.delete(alertRules).where(like(alertRules.name, `${prefix}%`));
  await db.delete(events).where(inArray(events.tenantId, tenantIds));
  await db.delete(cameras).where(inArray(cameras.tenantId, tenantIds));
  await db.delete(auditLog).where(and(
    gte(auditLog.createdAt, suiteStartedAt),
    inArray(auditLog.action, ["alert.ack_all", "alert.ack", "alert_rule.create", "alert_rule.toggle", "alert_rule.delete"]),
  ));
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  await pool.end();
}, { timeout: 30000 });

test("H-01-alerts(a): GET không trả event/camera/rule của tenant khác", async () => {
  const r = await call("/api/alerts?days=7", "GET", undefined, cookies.owner_a);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const ids = (r.data.items as { id: number }[]).map((x) => x.id);
  assert.ok(ids.includes(evA), "tenant A không thấy event của chính mình (positive control)");
  assert.ok(!ids.includes(evB), "LEAK: event tenant B lọt vào GET /api/alerts của tenant A");
  const ruleIds = (r.data.rules as { id: number }[]).map((x) => x.id);
  assert.ok(ruleIds.includes(ruleA), "tenant A không thấy rule của chính mình");
  assert.ok(!ruleIds.includes(ruleB), "LEAK: alert rule tenant B lọt vào tenant A");
  const camNames = (r.data.items as { camera: string }[]).map((x) => x.camera);
  assert.ok(!camNames.includes(camBName), "LEAK: tên/vị trí camera tenant B lọt vào tenant A");
});

test("H-01-alerts(b): POST {all:true} không ack event của tenant khác", async () => {
  await db.update(events).set({ ackAt: null, ackBy: null }).where(inArray(events.id, [evA, evB]));
  const r = await call("/api/alerts", "POST", { all: true }, cookies.owner_a);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const [b] = await db.select({ ackAt: events.ackAt, ackBy: events.ackBy }).from(events).where(eq(events.id, evB)).limit(1);
  assert.equal(b.ackAt, null, "LEAK/MASS-WRITE: tenant A ack event của tenant B");
  assert.equal(b.ackBy, null, "LEAK: ackBy của tenant A ghi vào dữ liệu tenant B");
});

test("H-01-alerts(c): POST {ids:[id tenant B]} bị chặn (IDOR)", async () => {
  await db.update(events).set({ ackAt: null, ackBy: null }).where(eq(events.id, evB));
  const r = await call("/api/alerts", "POST", { ids: [evB] }, cookies.owner_a);
  const [b] = await db.select({ ackAt: events.ackAt }).from(events).where(eq(events.id, evB)).limit(1);
  assert.equal(b.ackAt, null, "LEAK/IDOR: tenant A ack được event tenant B theo id");
  assert.equal(r.status, 404, `phải trả 404 khi không có hàng nào thuộc tenant; nhận ${r.status}`);
});

test("H-01-alerts(d): PUT toggle rule của tenant khác bị chặn", async () => {
  const [before] = await db.select({ enabled: alertRules.enabled }).from(alertRules).where(eq(alertRules.id, ruleB)).limit(1);
  const r = await call("/api/alerts", "PUT", { action: "toggle", id: ruleB }, cookies.owner_a);
  const [after] = await db.select({ enabled: alertRules.enabled }).from(alertRules).where(eq(alertRules.id, ruleB)).limit(1);
  assert.equal(after.enabled, before.enabled, "LEAK/WRITE: tenant A toggle rule tenant B");
  assert.equal(r.status, 404, `phải trả 404; nhận ${r.status}`);
});

test("H-01-alerts(e): PUT delete rule của tenant khác bị chặn", async () => {
  const r = await call("/api/alerts", "PUT", { action: "delete", id: ruleB }, cookies.owner_a);
  const [still] = await db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.id, ruleB)).limit(1);
  assert.ok(still, "LEAK/WRITE: tenant A xoá rule tenant B");
  assert.equal(r.status, 404, `phải trả 404; nhận ${r.status}`);
});

test("H-01-alerts(f): PUT create của tenant B ghi đúng tenant B (không rơi về default 1)", async () => {
  const r = await call("/api/alerts", "PUT", { action: "create", name: `${prefix}_ruleB2`, type: "alert", priority: "important" }, cookies.owner_b);
  assert.equal(r.status, 201, JSON.stringify(r.data).slice(0, 300));
  const row = r.data as { id: number; tenantId: number };
  assert.equal(row.tenantId, tB, "BUG: create của tenant B ghi vào tenant khác (default 1)");
});
