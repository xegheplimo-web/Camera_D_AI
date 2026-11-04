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
import { and, desc, eq, inArray } from "drizzle-orm";

/**
 * H-01h — auth.login / auth.login_failed phải ghi danh tính của user vừa xác
 * thực, không phải chủ nhân cookie cũ còn nằm trên request.
 *   - A (tenant A) giữ session; B (tenant B, tên & role khác) đăng nhập trên
 *     request vẫn mang cookie A ⇒ row auth.login phải ghi actor/actor_role/
 *     tenant_id của B — danh tính lấy từ user row vừa xác thực, không phải
 *     currentSession() (cookie được set SAU khi audit chạy).
 *   - Sai mật khẩu khi đang mang cookie A ⇒ auth.login_failed ghi actor NULL,
 *     không quy kết lầm cho A.
 * Suite không phá huỷ: chỉ dựng fixture riêng (tenant/user) và dọn sau.
 */
const prefix = `h01h_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const NAME_A = `${prefix}_name_a`;
const NAME_B = `${prefix}_name_b`;
const LOGIN_A = `${prefix}_a`;
const LOGIN_B = `${prefix}_b`;
let app: ChildProcess, base: string, cookieA: string;
const call: Call = makeCall(() => base);
const userIds: number[] = [];
const tenantIds: number[] = [];
let tA = 0, tB = 0, idB = 0;
let logs = "";

async function newestAudit(action: string, targetId: string) {
  const [row] = await db
    .select({ actor: auditLog.actor, actorRole: auditLog.actorRole, tenantId: auditLog.tenantId })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return row;
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
      { login: LOGIN_A, displayName: NAME_A, role: "owner", passwordHash, tenantId: tA },
      { login: LOGIN_B, displayName: NAME_B, role: "operator", passwordHash, tenantId: tB },
    ])
    .returning();
  userIds.push(...inserted.map((u) => u.id));
  idB = inserted.find((u) => u.login === LOGIN_B)!.id;

  const appPort = await freePort(); base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);

  // A đăng nhập trước và giữ cookie — mọi request sau giả lập browser "còn cookie A".
  cookieA = await loginUser(call, prefix, password, "a");
}, { timeout: 300000 });

after(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  await db.delete(auditLog).where(and(eq(auditLog.action, "auth.login"), inArray(auditLog.targetId, userIds.map(String))));
  await db.delete(auditLog).where(and(eq(auditLog.action, "auth.login_failed"), inArray(auditLog.targetId, [LOGIN_A, LOGIN_B])));
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  await pool.end();
}, { timeout: 20000 });

test("H-01h(a): B đăng nhập trên request mang cookie A ⇒ auth.login ghi danh tính B", async () => {
  const r = await call("/api/auth/login", "POST", { login: LOGIN_B, password }, cookieA);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const row = await newestAudit("auth.login", String(idB));
  assert.ok(row, "phải có audit row auth.login cho B");
  assert.equal(row.actor, NAME_B, "actor phải là B vừa xác thực, không phải chủ cookie A");
  assert.equal(row.actorRole, "operator", "actor_role phải là role của B");
  assert.equal(row.tenantId, tB, "tenant_id phải là tenant của B, không phải tenant của A");
});

test("H-01h(b): sai mật khẩu khi mang cookie A ⇒ auth.login_failed không quy kết cho A", async () => {
  const r = await call("/api/auth/login", "POST", { login: LOGIN_B, password: "sai-mat-khau" }, cookieA);
  assert.equal(r.status, 401, JSON.stringify(r.data).slice(0, 300));
  const row = await newestAudit("auth.login_failed", LOGIN_B);
  assert.ok(row, "phải có audit row auth.login_failed");
  assert.equal(row.actor, null, "login fail không được ghi actor của chủ cookie cũ");
  assert.equal(row.actorRole, null);
  assert.equal(row.tenantId, null);
});
