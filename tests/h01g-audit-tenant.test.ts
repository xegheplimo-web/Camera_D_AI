import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { ensureDefaultTenant } from "./helpers/tenant";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { db, pool } from "../src/db";
import { tenants, users, sessions, auditLog } from "../src/db/schema";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import { audit } from "../src/lib/audit";

/**
 * H-01g — audit_log.tenant_id là biên thật thay cho subquery display_name.
 *   - Tenant A và B có owner TRÙNG display_name; mỗi tenant 1 audit row có cùng
 *     actor đó ⇒ GET /api/admin của A chỉ trả row tenant_id=A (assert theo id —
 *     cơ chế display_name cũ sẽ lọt row B vì cùng tên).
 *   - Row tenant_id NULL (legacy/system) không hiện ở tenant nào.
 *   - alert.ack ghi qua audit() trong request đăng nhập ⇒ tenant_id = tenant
 *     của session (assert trực tiếp DB).
 *   - Negative: user bị xoá khỏi users mà JWT còn hạn ⇒ proxy chặn mọi route
 *     cần session (serverSession join users = null), còn /api/auth/login (public)
 *     vẫn 200 — audit() trong đó không throw và ghi row tenant_id=NULL.
 *   - audit() gọi ngoài request context (worker) ⇒ không crash.
 * Suite không phá huỷ: chỉ dựng fixture riêng (tenant/user/audit) và dọn sau.
 */
const prefix = `h01g_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const SHARED_NAME = `${prefix}_shared`;
const GHOST_NAME = `${prefix}_ghost`;
let app: ChildProcess, base: string;
const call: Call = makeCall(() => base);
const cookies: Record<string, string> = {};
const userIds: number[] = [];
const tenantIds: number[] = [];
const auditIds: number[] = [];
const logoutSids: string[] = [];
let tA = 0, tB = 0, ghostId = 0;
let rowA = 0, rowB = 0, rowNull = 0;
let logs = "";

/** sid lấy từ cookie dai_session (JWT body, không cần verify). */
function sidOf(cookie: string): string {
  const token = cookie.split("=")[1];
  return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).sid;
}

async function adminLogIds(cookie: string): Promise<number[]> {
  const r = await call("/api/admin", "GET", undefined, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  return (r.data.logs as { id: number }[]).map((l) => l.id);
}

before(async () => {
  // Fixture cần production build cho `next start` — build một lần nếu chưa có.
  if (!existsSync(".next/BUILD_ID")) {
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit" });
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
      { login: `${prefix}_owner_a`, displayName: SHARED_NAME, role: "owner", passwordHash, tenantId: tA },
      { login: `${prefix}_owner_b`, displayName: SHARED_NAME, role: "owner", passwordHash, tenantId: tB },
      { login: `${prefix}_ghost`, displayName: GHOST_NAME, role: "owner", passwordHash, tenantId: tB },
    ])
    .returning();
  userIds.push(...inserted.map((u) => u.id));
  ghostId = inserted.find((u) => u.login === `${prefix}_ghost`)!.id;

  // 3 hàng audit trực tiếp: A, B (cùng actor SHARED_NAME), và hệ thống tenant NULL.
  const rows = await db
    .insert(auditLog)
    .values([
      { tenantId: tA, actor: SHARED_NAME, actorRole: "owner", action: `${prefix}.a` },
      { tenantId: tB, actor: SHARED_NAME, actorRole: "owner", action: `${prefix}.b` },
      { tenantId: null, actor: "system", action: `${prefix}.sys` },
    ])
    .returning({ id: auditLog.id });
  [rowA, rowB, rowNull] = rows.map((r) => r.id);
  auditIds.push(rowA, rowB, rowNull);

  const appPort = await freePort(); base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  for (const who of ["owner_a", "owner_b", "ghost"]) cookies[who] = await loginUser(call, prefix, password, who);
  logoutSids.push(sidOf(cookies.owner_a), sidOf(cookies.ghost));
}, { timeout: 300000 });

after(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  if (auditIds.length) await db.delete(auditLog).where(inArray(auditLog.id, auditIds));
  await db.delete(auditLog).where(like(auditLog.action, `${prefix}%`));
  if (logoutSids.length) await db.delete(auditLog).where(and(eq(auditLog.action, "auth.logout"), inArray(auditLog.targetId, logoutSids)));
  await db.delete(auditLog).where(and(eq(auditLog.action, "alert.ack"), eq(auditLog.actor, SHARED_NAME)));
  await db.delete(auditLog).where(and(eq(auditLog.action, "auth.login"), inArray(auditLog.targetId, userIds.map(String))));
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  await pool.end();
}, { timeout: 20000 });

test("H-01g(a): hai tenant trùng display_name — GET /api/admin chỉ trả log tenant mình", async () => {
  const idsA = await adminLogIds(cookies.owner_a);
  assert.ok(idsA.includes(rowA), "tenant A không thấy audit row của chính mình");
  assert.ok(!idsA.includes(rowB), "audit row tenant B lọt vào tenant A (cùng display_name)");
  const idsB = await adminLogIds(cookies.owner_b);
  assert.ok(idsB.includes(rowB), "tenant B không thấy audit row của chính mình");
  assert.ok(!idsB.includes(rowA), "audit row tenant A lọt vào tenant B (cùng display_name)");
});

test("H-01g(b): audit row tenant_id NULL (legacy/system) ẩn khỏi mọi tenant", async () => {
  assert.ok(!(await adminLogIds(cookies.owner_a)).includes(rowNull), "row NULL hiện ở tenant A");
  assert.ok(!(await adminLogIds(cookies.owner_b)).includes(rowNull), "row NULL hiện ở tenant B");
});

test("H-01g: đổi display_name không làm log tenant B lọt sang tenant A", async () => {
  await db.update(users).set({ displayName: `${prefix}_renamed` }).where(eq(users.id, userIds[1]));
  const idsA = await adminLogIds(cookies.owner_a);
  assert.ok(idsA.includes(rowA));
  assert.ok(!idsA.includes(rowB), "log tenant B vẫn lọt sau khi đổi tên — cơ chế còn phụ thuộc display_name");
});

test("H-01g(c): audit() trong request đăng nhập ghi đúng tenant của session", async () => {
  // alert.ack với id không tồn tại: update 0 hàng (không mutate dữ liệu) nhưng
  // vẫn gọi audit() trong request có session hợp lệ.
  const r = await call("/api/alerts", "POST", { ids: [-1] }, cookies.owner_a);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [row] = await db
    .select({ tenantId: auditLog.tenantId, actor: auditLog.actor })
    .from(auditLog)
    .where(and(eq(auditLog.action, "alert.ack"), eq(auditLog.targetId, "-1")))
    .orderBy(desc(auditLog.id))
    .limit(1);
  assert.ok(row, "không có audit row alert.ack");
  assert.equal(row.actor, SHARED_NAME);
  assert.equal(row.tenantId, tA, "audit phải gắn tenant của session, không phải tenant khác/null");
});

test("H-01g(d): user bị xoá mà JWT còn hạn — audit() không throw, row tenant_id NULL, request vẫn 200", async () => {
  await db.delete(users).where(eq(users.id, ghostId));
  // Middleware proxy chặn mọi path cần session khi user không còn ⇒ đường duy
  // nhất audit() vẫn chạy với session stale là public path /api/auth/login.
  const r = await call("/api/auth/login", "POST", { login: `${prefix}_owner_b`, password }, cookies.ghost);
  assert.equal(r.status, 200, "request vẫn phải thành công khi user của cookie đã bị xoá");
  const [row] = await db
    .select({ tenantId: auditLog.tenantId, actor: auditLog.actor })
    .from(auditLog)
    .where(and(eq(auditLog.action, "auth.login"), eq(auditLog.targetId, String(userIds[1]))))
    .orderBy(desc(auditLog.id))
    .limit(1);
  assert.ok(row, "audit() vẫn phải ghi row dù không resolve được tenant");
  assert.equal(row.tenantId, null, "user không còn ⇒ tenant_id phải NULL (fail-closed)");
  assert.equal(row.actor, null, "session không resolve được ⇒ actor NULL");
});

test("H-01g(e): audit() gọi ngoài request context (worker) không crash", async () => {
  await assert.doesNotReject(audit(`${prefix}.worker`, { detail: "no request ctx" }));
});
