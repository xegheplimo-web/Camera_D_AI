import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { db, pool } from "../src/db";
import { users, sessions, auditLog } from "../src/db/schema";
import { inArray, like } from "drizzle-orm";

/**
 * T-1339 — tách tab Cài đặt (người dùng) / Quản trị (owner/operator) trên /settings.
 * SSR theo role từ session (page.tsx → currentSession) nên HTML khác nhau theo role:
 * owner/operator thấy nút tab "Quản trị" + ?tab=admin render panel quản trị;
 * viewer không thấy tab, ?tab=admin vẫn rơi về panel Cài đặt, API quản trị 403.
 */
const prefix = `t1339_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let app: ChildProcess, base: string;
const call: Call = makeCall(() => base);
const cookies: Record<string, string> = {};
const userIds: number[] = [];
let logs = "";

async function login(who: string) {
  cookies[who] = await loginUser(call, prefix, password, who);
}
/** HTML thô của trang (call() chỉ giữ 300 ký tự khi không parse được JSON). */
async function html(path: string, cookie: string): Promise<string> {
  const res = await fetch(base + path, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(res.status, 200, `${path} → ${res.status}`);
  return res.text();
}

before(async () => {
  // Fixture cần production build cho `next start` — build một lần nếu chưa có.
  if (!existsSync(".next/BUILD_ID")) {
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit" });
    assert.equal(r.status, 0, "next build thất bại (fixture cần `next start`)");
  }

  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  const inserted = await db.insert(users).values([
    { login: `${prefix}_owner`, displayName: `${prefix}_owner`, role: "owner", passwordHash },
    { login: `${prefix}_operator`, displayName: `${prefix}_operator`, role: "operator", passwordHash },
    { login: `${prefix}_viewer`, displayName: `${prefix}_viewer`, role: "viewer", passwordHash },
  ]).returning();
  userIds.push(...inserted.map((u) => u.id));

  const appPort = await freePort(); base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  for (const who of ["owner", "operator", "viewer"]) await login(who);
}, { timeout: 300000 });

after(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
  await pool.end();
}, { timeout: 20000 });

/* ============ 1. Tab bar + mặc định Cài đặt ============ */

test("owner: /settings có tablist, tab Cài đặt được chọn, có tab Quản trị", async () => {
  const h = await html("/settings", cookies.owner);
  assert.match(h, /role="tablist"/);
  assert.match(h, /id="tab-settings"[^>]*aria-selected="true"/, "tab Cài đặt phải được chọn mặc định");
  assert.match(h, /id="tab-admin"[^>]*aria-selected="false"/, "owner phải thấy tab Quản trị");
  assert.match(h, />Quản trị</);
  assert.match(h, /id="panel-settings"/, "mặc định render panel Cài đặt");
  assert.match(h, /Camera|Giọng nói/, "panel Cài đặt chứa card người dùng");
});

/* ============ 2. Deep-link ?tab=admin ============ */

test("owner: /settings?tab=admin chọn tab Quản trị và render panel quản trị", async () => {
  const h = await html("/settings?tab=admin", cookies.owner);
  assert.match(h, /id="tab-admin"[^>]*aria-selected="true"/);
  assert.match(h, /id="panel-admin"/);
  assert.match(h, /Nhật ký thao tác/);
  assert.match(h, /Vùng nguy hiểm/);
  assert.match(h, /Dữ liệu &amp; chế độ thật|Dữ liệu & chế độ thật/);
});

test("operator: cũng thấy tab Quản trị", async () => {
  const h = await html("/settings", cookies.operator);
  assert.match(h, /id="tab-admin"/, "operator là vai trò quản trị");
});

/* ============ 3. Viewer: không tab Quản trị, không panel, API quản trị 403 ============ */

test("viewer: không render tab/panel Quản trị kể cả khi ?tab=admin", async () => {
  for (const path of ["/settings", "/settings?tab=admin"]) {
    const h = await html(path, cookies.viewer);
    assert.ok(!h.includes('id="tab-admin"'), `${path}: viewer không được thấy tab Quản trị`);
    assert.ok(!h.includes('id="panel-admin"'), `${path}: viewer không được render panel quản trị`);
    assert.ok(!h.includes("Vùng nguy hiểm"), `${path}: nội dung quản trị không được rò rỉ`);
    assert.match(h, /id="panel-settings"/, `${path}: viewer vẫn thấy panel Cài đặt`);
    assert.match(h, /id="tab-settings"[^>]*aria-selected="true"/);
  }
});

test("viewer: API quản trị bị từ chối (403) — trang không có gì để tải", async () => {
  const v = cookies.viewer;
  assert.equal((await call("/api/admin", "GET", undefined, v)).status, 403);
  assert.equal((await call("/api/orchestration", "GET", undefined, v)).status, 403);
});
