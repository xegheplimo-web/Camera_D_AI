import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { ensureDefaultTenant } from "./helpers/tenant";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { db, pool } from "../src/db";
import { tenants, users, sessions, appSettings } from "../src/db/schema";
import { eq, inArray } from "drizzle-orm";

/**
 * H-01-settings (P0-1b) — `app_settings` là cấu hình NỀN TẢNG (platform-global):
 * `demoMode`, `retentionDays`, `remoteProcessingAllowed`, `detectEnabled`… thay đổi
 * chúng ảnh hưởng hành vi xử lý dữ liệu của MỌI tenant. Vì vậy chỉ tenant nền tảng
 * (PLATFORM_TENANT_ID, mặc định 1) được PATCH.
 *
 * RED trên HEAD trước bản vá: owner của tenant B PATCH {demoMode:true} → 200 và
 * ghi giá trị toàn cục; owner tenant A/B sau đó đọc thấy cấu hình do tenant khác đặt
 * (cross-tenant configuration control — N5 nâng lên P0 sau phản biện GPT R3).
 *
 * Fixture không phá dữ liệu dev: user/tenant theo prefix, snapshot + khôi phục `app_settings`.
 */
const prefix = `h01st_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let app: ChildProcess, base: string;
const call: Call = makeCall(() => base);
const cookies: Record<string, string> = {};
const userIds: number[] = [];
const tenantIds: number[] = [];
let tB = 0;
let demoModeBefore: unknown = undefined;
let demoModeExisted = false;
let logs = "";

before(async () => {
  if (!(process.env.SKIP_BUILD === "1" && existsSync(".next/BUILD_ID"))) {
    const r = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build"], { stdio: "inherit", cwd: process.cwd() });
    assert.equal(r.status, 0, "next build thất bại (fixture cần `next start`)");
  }

  await ensureDefaultTenant();
  const [snap] = await db.select().from(appSettings).where(eq(appSettings.key, "demoMode")).limit(1);
  demoModeBefore = snap?.value;
  demoModeExisted = !!snap;
  // Trạng thái khởi điểm phải xác định: dev DB có thể đang demoMode=true (seed hoặc
  // người dùng bật tay). Ép về false để test (a) chỉ còn phụ thuộc vào việc PATCH bị chặn,
  // không phụ thuộc giá trị cũ. after() khôi phục đúng giá trị đã snapshot.
  await db.insert(appSettings).values({ key: "demoMode", value: false })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: false, updatedAt: new Date() } });

  const [t] = await db.insert(tenants).values({ slug: `${prefix}-b`, name: `${prefix} B` }).returning();
  tB = t.id;
  tenantIds.push(tB);

  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  const inserted = await db
    .insert(users)
    .values([
      { login: `${prefix}_owner_1`, displayName: `${prefix}_owner_1`, role: "owner", passwordHash, tenantId: 1 },
      { login: `${prefix}_owner_b`, displayName: `${prefix}_owner_b`, role: "owner", passwordHash, tenantId: tB },
    ])
    .returning();
  userIds.push(...inserted.map((u) => u.id));

  const appPort = await freePort(); base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  for (const who of ["owner_1", "owner_b"]) cookies[who] = await loginUser(call, prefix, password, who);
}, { timeout: 300000 });

after(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  // Khôi phục app_settings.demoMode đúng như trước khi chạy (không xoá cả bảng).
  await db.delete(appSettings).where(eq(appSettings.key, "demoMode"));
  if (demoModeExisted) await db.insert(appSettings).values({ key: "demoMode", value: demoModeBefore });
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  await pool.end();
}, { timeout: 30000 });

test("H-01-settings(a): owner tenant B không được đổi cấu hình nền tảng", async () => {
  const r = await call("/api/settings", "PATCH", { demoMode: true }, cookies.owner_b);
  assert.equal(r.status, 403, `settings là cấu hình nền tảng → phải 403; nhận ${r.status}`);
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "demoMode")).limit(1);
  assert.notEqual(row?.value, true, "LEAK/WRITE: tenant B ghi demoMode toàn cục");
});

test("H-01-settings(b): owner tenant nền tảng vẫn đổi được (positive control)", async () => {
  const r = await call("/api/settings", "PATCH", { demoMode: true }, cookies.owner_1);
  assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300));
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, "demoMode")).limit(1);
  assert.equal(row?.value, true, "tenant nền tảng PATCH xong nhưng DB không đổi");
});
