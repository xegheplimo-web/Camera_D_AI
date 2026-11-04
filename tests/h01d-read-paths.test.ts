import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { ensureDefaultTenant } from "./helpers/tenant";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { db, pool } from "../src/db";
import { aiJobs, auditLog, cameras, events, messages, sessions, tenants, users } from "../src/db/schema";
import { and, eq, gte, inArray, like, lt, sql } from "drizzle-orm";
import { evidenceWorker, reportScope, summaryWorker } from "../src/lib/ai/memory-worker";
import { enqueueJob } from "../src/lib/ai/jobs";
import { AiError, type JobInput } from "../src/lib/ai/types";
import { getSettings } from "../src/lib/settings";
import { addDays, startOfDayVN } from "../src/lib/time";
import type { SessionPayload } from "../src/lib/token";

/**
 * H-01d — các đường đọc /api/dashboard, /api/stats, /api/report, GET /api/cameras
 * và memory-worker.reportScope() phải lọc theo tenant của session/job.
 * Repro bug (artifacts/repro-h01d.ts): session tenant 1 thấy số liệu, sự kiện,
 * báo cáo và danh sách camera của tenant 2; reportScope đọc cameras/events toàn cục.
 * Suite này dựng tenant 2 "canary" (camera CAM-77 + event marker duy nhất) và
 * tenant-1 control rows, spawn `next start` trên port riêng rồi assert cả hai chiều:
 *   - response tenant 1 không chứa marker canary và số liệu khớp đếm trực tiếp DB tenant 1
 *   - reportScope có input.tenantId chỉ trả event tenant đó; thiếu ⇒ TENANT_REQUIRED
 *   - chat fast-path insert messages gắn tenant_id của session (không rơi về default 1)
 *   - enqueueJob truyền tenantId vào job.input để worker scope sống qua hàng đợi
 *   - POST /api/cameras gắn tenantId tường minh
 * Fixture dọn trong after() — chỉ xoá row do chính suite tạo.
 */
const prefix = `h01d_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const CAM_CODE = "CAM-77";
let app: ChildProcess, base: string;
const call: Call = makeCall(() => base);
const cookies: Record<string, string> = {};
let logs = "";

let t2 = 0;
let u2: typeof users.$inferSelect;
let t1CamId = 0, canaryCamId = 0;
const t1EvIds: number[] = [];
const canaryEvIds: number[] = [];
const userIds: number[] = [];
const camIds: number[] = [];
const jobIds: string[] = [];
let demoMode = false;

const sess = (user: { id: number; displayName: string }): SessionPayload => ({
  sid: `${prefix}-sid-${user.id}`,
  sub: user.id,
  name: user.displayName,
  role: "owner",
  device: "test",
  exp: Math.floor(Date.now() / 1000) + 3600,
});

const jobInput = (over: Partial<JobInput> = {}): JobInput => ({
  question: "báo cáo hôm nay",
  demoMode: true,
  allowRemote: false,
  asOf: new Date().toISOString(),
  ...over,
});

/** Đếm trực tiếp events của 1 tenant trong khoảng [start,end) — mirror điều kiện endpoint. */
async function countEvents(tenant: number, start: Date, end: Date, trustedOnly: boolean) {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(events)
    .where(
      and(
        eq(events.tenantId, tenant),
        gte(events.happenedAt, start),
        lt(events.happenedAt, end),
        ...(trustedOnly ? [eq(events.clientReported, false)] : []),
        ...(demoMode ? [] : [sql`${events.source} <> 'demo'`])
      )
    );
  return r.c;
}

async function countCameras(tenant: number) {
  const [r] = await db.select({ c: sql<number>`count(*)::int` }).from(cameras).where(eq(cameras.tenantId, tenant));
  return r.c;
}

before(async () => {
  // Fixture cần production build cho `next start` — build một lần nếu chưa có.
  if (!existsSync(".next/BUILD_ID")) {
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit" });
    assert.equal(r.status, 0, "next build thất bại (fixture cần `next start`)");
  }

  await ensureDefaultTenant();
  demoMode = (await getSettings()).demoMode;
  const [tenant2] = await db.insert(tenants).values({ slug: `${prefix}-t2`, name: `${prefix} tenant` }).returning();
  t2 = tenant2.id;

  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  const inserted = await db
    .insert(users)
    .values([
      { login: `${prefix}_owner_t1`, displayName: `${prefix}_owner_t1`, role: "owner", passwordHash, tenantId: 1 },
      { login: `${prefix}_owner_t2`, displayName: `${prefix}_owner_t2`, role: "owner", passwordHash, tenantId: t2 },
    ])
    .returning();
  userIds.push(...inserted.map((u) => u.id));
  u2 = inserted.find((u) => u.login === `${prefix}_owner_t2`)!;

  // Control tenant 1: camera + event "live" của chính tenant 1 (phải xuất hiện trong response).
  const [cam1] = await db
    .insert(cameras)
    .values({ tenantId: 1, code: `${prefix}-C1`, name: `${prefix}_T1_CAM`, location: `${prefix}_T1_LOC`, sourceType: "demo", status: "demo" })
    .returning();
  t1CamId = cam1.id;
  camIds.push(cam1.id);
  const ev1 = await db
    .insert(events)
    .values([
      { tenantId: 1, cameraId: cam1.id, type: "person_in", objectClass: "person", label: `${prefix}_T1_EV_A`, source: "live", clientReported: false, happenedAt: new Date() },
      { tenantId: 1, cameraId: cam1.id, type: "vehicle", objectClass: "car", label: `${prefix}_T1_EV_B`, source: "live", clientReported: false, happenedAt: new Date() },
    ])
    .returning({ id: events.id });
  t1EvIds.push(...ev1.map((e) => e.id));

  // Canary tenant 2: camera CAM-77 + 3 event marker duy nhất — tenant 1 không bao giờ được thấy.
  const [cam2] = await db
    .insert(cameras)
    .values({ tenantId: t2, code: CAM_CODE, name: `${prefix}_CANARY_CAM`, location: `${prefix}_CANARY_LOC`, sourceType: "demo", status: "demo" })
    .returning();
  canaryCamId = cam2.id;
  camIds.push(cam2.id);
  const ev2 = await db
    .insert(events)
    .values([
      { tenantId: t2, cameraId: cam2.id, type: "person_in", objectClass: "person", label: `${prefix}_CANARY_EV_A`, source: "live", clientReported: false, happenedAt: new Date() },
      { tenantId: t2, cameraId: cam2.id, type: "person_in", objectClass: "person", label: `${prefix}_CANARY_EV_B`, source: "live", clientReported: false, happenedAt: new Date() },
      { tenantId: t2, cameraId: cam2.id, type: "alert", objectClass: "person", label: `${prefix}_CANARY_EV_C`, source: "live", clientReported: false, happenedAt: new Date() },
    ])
    .returning({ id: events.id });
  canaryEvIds.push(...ev2.map((e) => e.id));

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
  for (const who of ["owner_t1", "owner_t2"]) cookies[who] = await loginUser(call, prefix, password, who);
}, { timeout: 300000 });

after(async () => {
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  if (jobIds.length) await db.delete(aiJobs).where(inArray(aiJobs.id, jobIds));
  if (camIds.length) await db.delete(events).where(inArray(events.cameraId, camIds));
  if (camIds.length) await db.delete(cameras).where(inArray(cameras.id, camIds));
  if (userIds.length) {
    await db.delete(messages).where(inArray(messages.userId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  if (t2) await db.delete(tenants).where(eq(tenants.id, t2));
  await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
  await pool.end();
}, { timeout: 20000 });

test("GET /api/dashboard tenant 1: không marker canary, today.total + cameras khớp DB tenant 1", async () => {
  const r = await call("/api/dashboard", "GET", undefined, cookies.owner_t1);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const j = JSON.stringify(r.data);
  assert.ok(!j.includes("CANARY"), "dashboard lộ marker tenant 2");
  const start = startOfDayVN();
  assert.equal(r.data.today.total, await countEvents(1, start, addDays(start, 1), true), "today.total phải khớp đếm trực tiếp events tenant 1");
  assert.equal(r.data.cameras.length, await countCameras(1), "danh sách camera phải đúng số camera tenant 1");
  assert.ok(!r.data.cameras.some((c: { id: number }) => c.id === canaryCamId), "camera tenant 2 lọt vào dashboard");
  assert.ok(r.data.cameras.some((c: { id: number }) => c.id === t1CamId), "camera tenant 1 của suite phải hiện");
});

test("GET /api/stats?days=7 tenant 1: không marker canary, totals.total khớp DB tenant 1", async () => {
  const r = await call("/api/stats?days=7", "GET", undefined, cookies.owner_t1);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  assert.ok(!JSON.stringify(r.data).includes("CANARY"), "stats lộ marker tenant 2");
  const end = addDays(startOfDayVN(), 1);
  const expected = await countEvents(1, addDays(end, -7), end, true);
  assert.equal(r.data.totals.total, expected, "totals.total phải khớp đếm trực tiếp events tenant 1");
  assert.equal(r.data.meta.total, expected, "meta.total (share) cũng phải scope tenant");
  assert.ok(!r.data.byCamera.some((b: { cameraId: number }) => b.cameraId === canaryCamId), "byCamera chứa camera tenant 2");
});

test("GET /api/report?days=7 (CSV) tenant 1: không chứa marker canary, số dòng khớp DB tenant 1", async () => {
  const res = await fetch(`${base}/api/report?days=7`, { headers: { Cookie: cookies.owner_t1 }, redirect: "manual" });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("CANARY"), "report CSV lộ marker tenant 2");
  assert.ok(text.includes(`${prefix}_T1_EV`), "report CSV thiếu event tenant 1 của suite");
  const lines = text.replace(/^\uFEFF/, '').trim().split("\n"); // strip BOM \uFEFF
  const end = addDays(startOfDayVN(), 1);
  // report không lọc clientReported (cột client_chua_duyet) — chỉ tenant + demo filter.
  const expected = await countEvents(1, addDays(end, -7), end, false);
  assert.equal(lines.length - 1, expected, "số dòng CSV phải bằng events tenant 1 trong range");
});

test("GET /api/cameras tenant 1: chỉ trả camera tenant của session", async () => {
  const r = await call("/api/cameras", "GET", undefined, cookies.owner_t1);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  assert.ok(!JSON.stringify(r.data).includes("CANARY"), "cameras list lộ marker tenant 2");
  assert.equal(r.data.length, await countCameras(1));
  const ids = r.data.map((c: { id: number }) => c.id);
  assert.ok(ids.includes(t1CamId));
  assert.ok(!ids.includes(canaryCamId));
});

test("POST /api/cameras gắn tenantId tường minh theo session (không rơi về default 1)", async () => {
  const r = await call("/api/cameras", "POST", { name: `${prefix}_T2_NEW`, location: `${prefix}_T2_NEWLOC`, sourceType: "demo" }, cookies.owner_t2);
  assert.equal(r.status, 201, JSON.stringify(r.data).slice(0, 300));
  assert.equal(r.data.tenantId, t2, "camera mới phải mang tenant_id của session");
  const [row] = await db.select().from(cameras).where(eq(cameras.id, r.data.id));
  assert.equal(row.tenantId, t2, "row trong DB phải ghi tenant_id tenant 2");
  camIds.push(row.id);
  // Camera mới của tenant 2 không xuất hiện trong list tenant 1.
  const g = await call("/api/cameras", "GET", undefined, cookies.owner_t1);
  assert.ok(!(g.data as { id: number }[]).some((c) => c.id === row.id));
});

test("reportScope với input.tenantId=tenant2 chỉ trả event tenant đó (đối soát DB)", async () => {
  const scope = await reportScope(jobInput({ tenantId: t2 }));
  const rows = await db.select().from(events).where(scope.where);
  assert.ok(rows.length >= 3, "phải thấy đủ event canary của tenant 2");
  assert.ok(rows.every((r) => r.tenantId === t2), "scope.where còn trả event tenant khác");
  for (const id of canaryEvIds) assert.ok(rows.some((r) => r.id === id), `thiếu event canary ${id}`);
  for (const id of t1EvIds) assert.ok(!rows.some((r) => r.id === id), `lọt event tenant 1 (${id})`);
  const expected = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.tenantId, t2), gte(events.happenedAt, scope.start), lt(events.happenedAt, scope.end), eq(events.clientReported, false)));
  assert.equal(rows.length, expected[0].c, "số event trả về phải khớp đếm trực tiếp tenant 2");
});

test("reportScope phân giải camera trong tenant: tenant 2 thấy CAM-77, tenant 1 thì CAMERA_NOT_FOUND", async () => {
  const s2 = await reportScope(jobInput({ question: "báo cáo camera 77 hôm nay", tenantId: t2 }));
  assert.equal(s2.camera, `${prefix}_CANARY_CAM – ${prefix}_CANARY_LOC`);
  const rows = await db.select().from(events).where(s2.where);
  assert.ok(rows.every((r) => r.tenantId === t2 && r.cameraId === canaryCamId));
  await assert.rejects(
    reportScope(jobInput({ question: "báo cáo camera 77 hôm nay", tenantId: 1 })),
    (e) => e instanceof AiError && e.code === "CAMERA_NOT_FOUND",
    "tenant 1 không được resolve camera của tenant 2"
  );
});

test("reportScope thiếu input.tenantId ⇒ throw TENANT_REQUIRED, không đọc toàn cục", async () => {
  await assert.rejects(
    reportScope(jobInput()),
    (e) => e instanceof AiError && e.code === "TENANT_REQUIRED" && e.httpStatus === 400
  );
  await assert.rejects(
    summaryWorker(jobInput()),
    (e) => e instanceof AiError && e.code === "TENANT_REQUIRED",
    "summaryWorker cũng phải fail closed khi thiếu tenant"
  );
});

test("summaryWorker + evidenceWorker (2 worker dùng reportScope) giữ scope tenant 2", async () => {
  const s = await summaryWorker(jobInput({ tenantId: t2 }));
  const dayStart = startOfDayVN();
  const expected = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.tenantId, t2), gte(events.happenedAt, dayStart), lt(events.happenedAt, s.scope.end), eq(events.clientReported, false)));
  assert.equal(s.totals.total, expected[0].c);
  const ev = await evidenceWorker(jobInput({ tenantId: t2 }), sess(u2));
  assert.ok(ev.length > 0);
  assert.ok(ev.every((e) => e.eventId != null && canaryEvIds.includes(e.eventId)), "evidence lọt event tenant khác");
});

test("POST /api/chat fast path insert messages gắn tenant_id của session tenant 2", async () => {
  const rid = `${prefix}-chat1`;
  const r = await call("/api/chat", "POST", { question: "hôm nay có bao nhiêu khách?", requestId: rid }, cookies.owner_t2);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const rows = await db.select().from(messages).where(and(eq(messages.userId, u2.id), eq(messages.requestKey, `chat:${rid}`)));
  assert.equal(rows.length, 2, "fast path phải lưu user + assistant message");
  assert.ok(rows.every((m) => m.tenantId === t2), "messages phải gắn tenant_id của session, không rơi về default 1");
});

test("enqueueJob report truyền tenantId vào job.input (worker scope sống qua hàng đợi)", async () => {
  const { job } = await enqueueJob(
    "report",
    { question: `${prefix} báo cáo tổng hợp?`, demoMode: true, allowRemote: false, asOf: new Date().toISOString() },
    sess(u2),
    `h01d:${randomUUID()}`
  );
  jobIds.push(job.id);
  assert.equal(job.tenantId, t2);
  assert.equal(job.input.tenantId, t2, "job.input phải mang tenantId để reportScope không TENANT_REQUIRED");
});
