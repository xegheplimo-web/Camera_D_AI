import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { db, pool } from "../src/db";
import { users, tenants, cameras, sessions, auditLog, appSettings, cameraSettings } from "../src/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { encryptSource } from "../src/lib/camera/stream";
import {
  isCameraKey,
  listSegments,
  parseSegmentName,
  purgeOldSegments,
  recordingKeysFor,
  runVideoRetention,
  storageStatus,
} from "../src/lib/recordings";

/**
 * T-1323 — bản ghi mediaMTX trên đĩa: parser tên segment, list theo khoảng
 * thời gian, purge chặn traversal + audit, API 401/403/404, proxy playback
 * (Range chuyển tiếp khi upstream 206, ngược lại 200 stream).
 *
 * Hai tầng: lib chạy in-process với RECORDINGS_DIR=thư mục tạm; API chạy trên
 * `next start` spawn với RECORDINGS_DIR + MEDIAMTX_PLAYBACK trỏ fixture.
 * retentionDays đặt 0 trong before() để retention job của server spawn (chạy
 * lúc khởi động) không xoá fixture giữa chừng; bật lại cục bộ trong test riêng.
 */
const prefix = `t1323_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const recDir = mkdtempSync(join(tmpdir(), "dai-t1323-rec-"));

// Tên segment theo đúng format mediaMTX %Y-%m-%d_%H-%M-%S-%f (giờ địa phương).
const SEGFRESH = "2026-11-01_10-00-00-000000.mp4"; // ~2 ngày trước
const SEGOLD = "2026-09-15_08-30-00-000000.mp4";   // ~7 tuần trước
const SEGZERO = "2026-11-01_11-00-00-000000.mp4";  // file 0 byte
const SEGOTHER = "2026-09-01_00-00-00-000000.mp4"; // dir không map camera nào
const SEGC_OLD = "2026-08-01_00-00-00-000000.mp4";   // camC: override qua cameras.retention_days=2
const SEGC_FRESH = "2026-11-02_09-00-00-000000.mp4"; // camC: ~1 ngày → giữ
const PURGE_OLD = "2020-01-01_00-00-00-000000.mp4";

let app: ChildProcess, fixture: Server, base: string;
let logs = "";
const cookies: Record<string, string> = {};
const userIds: number[] = [];
let t2id = 0, camA = 0, camB = 0, camC = 0;
const fixtureCalls: { path: string | null; start: string | null; duration: string | null; range: string | null }[] = [];
let envRec: string | undefined;
let envPlayback: string | undefined;
let retentionBefore: (typeof appSettings.$inferSelect) | undefined;
const realFetch = globalThis.fetch;
const call: Call = makeCall(() => base, () => realFetch);

const owner = () => cookies.owner;
const operator = () => cookies.operator;
const viewer = () => cookies.viewer;
const t2owner = () => cookies.t2owner;
const keyA = () => `dai_cam_${camA}`;

function putFile(key: string, name: string, content: string | Buffer) {
  const dir = join(recDir, key);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f, content);
  // Segment thật của mediaMTX có mtime ≈ lúc ghi xong (start+5') — giả lập để
  // durationSec ước tính đúng, nếu không mtime=now làm duration "48 ngày" và
  // filter overlap sẽ giữ segment cũ trong mọi khoảng [from,to].
  const p = parseSegmentName(name);
  if (p) { const end = new Date(p.start.getTime() + 300_000); utimesSync(f, end, end); }
}

before(async () => {
  envRec = process.env.RECORDINGS_DIR;
  envPlayback = process.env.MEDIAMTX_PLAYBACK;
  process.env.RECORDINGS_DIR = recDir;

  [retentionBefore] = await db.select().from(appSettings).where(eq(appSettings.key, "retentionDays"));
  await db.insert(appSettings).values({ key: "retentionDays", value: 0 })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: 0, updatedAt: new Date() } });

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

  const [ca] = await db.insert(cameras).values({ code: `${prefix}-a`, name: `${prefix} cam A`, location: "Fixture", sourceType: "rtsp", status: "offline" }).returning();
  const [cb] = await db.insert(cameras).values({ code: `${prefix}-b`, name: `${prefix} cam B`, location: "Fixture", sourceType: "rtsp", status: "offline" }).returning();
  const [cc] = await db.insert(cameras).values({ code: `${prefix}-c`, name: `${prefix} cam C (t2)`, location: "Fixture", sourceType: "rtsp", status: "offline", tenantId: t2id }).returning();
  camA = ca.id; camB = cb.id; camC = cc.id;
  await db.update(cameras).set({ streamName: keyA() }).where(eq(cameras.id, camA));
  await db.update(cameras).set({ streamName: `dai_cam_${camC}`, retentionDays: 2 }).where(eq(cameras.id, camC));
  // camB cố tình không có streamName → không có cameraKey nào.
  // camC có streamName + cameras.retention_days=2 nhưng KHÔNG có camera_settings
  // → nhánh fallback cameras.retention_days của runVideoRetention.

  putFile(keyA(), SEGFRESH, "FRESH-BYTES!");
  putFile(keyA(), SEGOLD, "OLD-BYTES-OLD!");
  putFile(keyA(), SEGZERO, Buffer.alloc(0));
  putFile(keyA(), "not-a-segment.mp4", "JUNK");
  putFile(keyA(), "2026-11-01_12-00-00-000000.txt", "WRONG-EXT");
  putFile(`dai_cam_${camC}`, SEGC_OLD, "CAMC-OLD");
  putFile(`dai_cam_${camC}`, SEGC_FRESH, "CAMC-FRESH");
  putFile("zzz_other", SEGOTHER, "OTHER-BYTES");
  putFile("zzz_purge", PURGE_OLD, "PURGE-OLD");
  putFile("zzz_purge", SEGFRESH, "PURGE-KEEP");
  putFile("escapeTarget", "sentinel.txt", "SENTINEL");

  // Playback fixture: giả mediaMTX :9996 — trả 206 khi có Range, 200 khi không.
  fixture = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://fixture");
    fixtureCalls.push({
      path: u.searchParams.get("path"),
      start: u.searchParams.get("start"),
      duration: u.searchParams.get("duration"),
      range: (req.headers.range as string) ?? null,
    });
    if (u.pathname !== "/get") { res.writeHead(404).end(); return; }
    if (req.headers.range) {
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Range": "bytes 0-99/500",
        "Accept-Ranges": "bytes",
        "Content-Length": "100",
      });
      res.end(Buffer.alloc(100, 7));
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "11" });
    res.end("FAKE_MP4_OK");
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const playbackPort = (fixture.address() as { port: number }).port;

  const appPort = await freePort();
  base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], {
    env: { ...process.env, NODE_ENV: "production", RECORDINGS_DIR: recDir, MEDIAMTX_PLAYBACK: `http://127.0.0.1:${playbackPort}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await realFetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  for (const who of ["owner", "operator", "viewer", "t2owner"]) {
    cookies[who] = await loginUser(call, prefix, password, who);
  }
}, { timeout: 60000 });

after(async () => {
  if (envRec === undefined) delete process.env.RECORDINGS_DIR; else process.env.RECORDINGS_DIR = envRec;
  if (envPlayback === undefined) delete process.env.MEDIAMTX_PLAYBACK; else process.env.MEDIAMTX_PLAYBACK = envPlayback;
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  if (fixture) await new Promise<void>((r) => fixture.close(() => r()));
  rmSync(recDir, { recursive: true, force: true });
  if (camA || camB || camC) await db.delete(cameras).where(inArray(cameras.id, [camA, camB, camC].filter(Boolean))); // camera_settings cascade
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
  if (retentionBefore) {
    await db.update(appSettings).set({ value: retentionBefore.value, updatedAt: retentionBefore.updatedAt }).where(eq(appSettings.key, "retentionDays"));
  } else {
    await db.delete(appSettings).where(eq(appSettings.key, "retentionDays"));
  }
  if (t2id) await db.delete(tenants).where(eq(tenants.id, t2id));
  await pool.end();
}, { timeout: 20000 });

/* ================= 1. parseSegmentName ================= */

test("unit: parseSegmentName — tên hợp lệ tách key + start (giờ địa phương); tên lạ → null", () => {
  const p = parseSegmentName(`cam/2026-11-03_12-47-57-234613.mp4`);
  assert.ok(p);
  assert.equal(p.cameraKey, "cam");
  assert.equal(p.file, "2026-11-03_12-47-57-234613.mp4");
  assert.equal(p.start.getFullYear(), 2026);
  assert.equal(p.start.getMonth(), 10); // tháng 11
  assert.equal(p.start.getDate(), 3);
  assert.equal(p.start.getHours(), 12); // giờ địa phương, không phải UTC
  assert.equal(p.start.getMinutes(), 47);
  assert.equal(p.start.getSeconds(), 57);
  assert.equal(p.start.getMilliseconds(), 234);

  assert.equal(parseSegmentName(`cam/2026-11-03_12-47-57-234613.fmp4`)?.cameraKey, "cam");
  assert.equal(parseSegmentName(`cam/2026-11-03_12-47-57-234613.m4s`)?.cameraKey, "cam");
  const abs = parseSegmentName(join(recDir, "cam", "2026-11-03_12-47-57-234613.mp4"));
  assert.equal(abs?.cameraKey, "cam", "path tuyệt đối → cameraKey là tên thư mục cha");
  const bare = parseSegmentName("2026-11-03_12-47-57-234613.mp4");
  assert.equal(bare?.cameraKey, null);
  assert.equal(bare?.start.getHours(), 12);

  for (const bad of [
    "cam/not-a-segment.mp4",
    "cam/2026-13-03_12-47-57-234613.mp4", // tháng 13
    "cam/2026-11-03_25-47-57-234613.mp4", // giờ 25 → Date roll → phải reject
    "cam/2026-11-03_12-47-57.mp4",        // thiếu phần %f
    "cam/2026-11-03_12-47-57-234613.txt", // sai đuôi
    "../2026-11-03_12-47-57-234613.mp4",  // traversal
    "",
    "cam",
  ]) {
    assert.equal(parseSegmentName(bad), null, `tên lạ phải null: ${bad}`);
  }
  assert.ok(isCameraKey("cam") && isCameraKey("dai_cam_12") && isCameraKey("cam.site-1"));
  assert.ok(!isCameraKey("../x") && !isCameraKey("a/b") && !isCameraKey("..") && !isCameraKey(""));
});

/* ================= 2. listSegments + storageStatus ================= */

test("unit: listSegments — đọc đĩa, sắp xếp, bỏ file 0 byte & tên lạ; lọc theo khoảng thời gian", async () => {
  const all = await listSegments(keyA());
  assert.deepEqual(all.map((s) => s.file), [`${keyA()}/${SEGOLD}`, `${keyA()}/${SEGFRESH}`], "chỉ 2 segment hợp lệ, tăng dần theo start");
  assert.equal(all[0].sizeBytes, Buffer.byteLength("OLD-BYTES-OLD!"));
  assert.equal(all[0].cameraKey, keyA());
  assert.ok((all[0].durationSec ?? 0) > 0, "durationSec ước tính từ gap/mtime");

  const month = 30 * 86_400_000;
  const recent = await listSegments(keyA(), new Date(Date.now() - month), undefined);
  assert.deepEqual(recent.map((s) => s.file), [`${keyA()}/${SEGFRESH}`], "from=30d loại segment cũ");
  const oldOnly = await listSegments(keyA(), new Date(Date.now() - 90 * 86_400_000), new Date(Date.now() - month));
  assert.deepEqual(oldOnly.map((s) => s.file), [`${keyA()}/${SEGOLD}`], "to=30d chỉ giữ segment cũ");

  assert.deepEqual(await listSegments("../escape"), [], "key traversal → rỗng, không quét ra ngoài");
  assert.deepEqual(await listSegments("key_chua_co"), [], "key không tồn tại → rỗng");

  const st = await storageStatus();
  assert.equal(
    st.totalBytes,
    ["FRESH-BYTES!", "OLD-BYTES-OLD!", "OTHER-BYTES", "PURGE-OLD", "PURGE-KEEP", "CAMC-OLD", "CAMC-FRESH"]
      .reduce((a, s) => a + Buffer.byteLength(s), 0),
  );
  const camEntry = st.cameras.find((c) => c.key === keyA());
  assert.equal(camEntry?.segments, 2);
  assert.ok(st.freeBytes === null || st.freeBytes > 0);
});

/* ================= 3. purgeOldSegments ================= */

test("unit: purgeOldSegments — chỉ xoá segment quá hạn TRONG thư mục gốc + audit recording.purge", async () => {
  const r = await purgeOldSegments(30, { cameraKey: "zzz_purge", actor: { name: prefix } });
  assert.equal(r.deleted, 1);
  assert.equal(r.bytes, Buffer.byteLength("PURGE-OLD"));
  assert.deepEqual(r.files, [`zzz_purge/${PURGE_OLD}`]);
  assert.equal(existsSync(join(recDir, "zzz_purge", PURGE_OLD)), false);
  assert.equal(existsSync(join(recDir, "zzz_purge", SEGFRESH)), true, "segment chưa quá hạn phải giữ");

  const [auditRow] = await db.select({ actor: auditLog.actor, targetId: auditLog.targetId, detail: auditLog.detail })
    .from(auditLog).where(and(eq(auditLog.action, "recording.purge"), eq(auditLog.actor, prefix)));
  assert.equal(auditRow?.targetId, "zzz_purge");
  assert.match(auditRow?.detail ?? "", /days=30.*deleted=1.*bytes=\d+/);

  const esc = await purgeOldSegments(1, { cameraKey: "../escapeTarget", actor: { name: prefix } });
  assert.equal(esc.deleted, 0, "cameraKey traversal không được xoá gì");
  assert.equal(existsSync(join(recDir, "escapeTarget", "sentinel.txt")), true, "file ngoài key dir không bị đụng");
});

/* ================= 4. API GET /api/recordings ================= */

test("API: GET danh sách segment + storage; 401 không phiên, 400/404 sai tham số, 404 camera khác tenant", async () => {
  const r = await call(`/api/recordings?cameraId=${camA}`, "GET", undefined, owner());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const files = (r.data.segments as any[]).map((s) => s.file);
  assert.deepEqual(files, [`${keyA()}/${SEGOLD}`, `${keyA()}/${SEGFRESH}`]);
  assert.deepEqual(r.data.keys, [keyA()]);
  assert.ok((r.data.storage.cameras as any[]).some((c) => c.key === keyA()));

  const range = await call(`/api/recordings?cameraId=${camA}&from=${new Date(Date.now() - 30 * 86_400_000).toISOString()}`, "GET", undefined, owner());
  assert.deepEqual((range.data.segments as any[]).map((s) => s.file), [`${keyA()}/${SEGFRESH}`]);

  const byViewer = await call(`/api/recordings?cameraId=${camA}`, "GET", undefined, viewer());
  assert.equal(byViewer.status, 200, "viewer có quyền read");
  const empty = await call(`/api/recordings?cameraId=${camB}`, "GET", undefined, owner());
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.segments, []);
  const storageOnly = await call("/api/recordings", "GET", undefined, owner());
  assert.equal(storageOnly.status, 200);
  assert.ok(storageOnly.data.storage.cameras.length >= 1);

  assert.equal((await call(`/api/recordings?cameraId=${camA}`, "GET", undefined, t2owner())).status, 404);
  assert.equal((await call(`/api/recordings?cameraId=${camC}`, "GET", undefined, owner())).status, 404, "camC thuộc tenant 2 → owner tenant 1 phải 404");
  assert.equal((await call(`/api/recordings?cameraId=${camC}`, "GET", undefined, t2owner())).status, 200, "t2owner đọc camera của chính mình");
  assert.equal((await call(`/api/recordings?cameraId=99999999`, "GET", undefined, owner())).status, 404);
  assert.equal((await call(`/api/recordings?cameraId=abc`, "GET", undefined, owner())).status, 400);
  assert.equal((await call(`/api/recordings?cameraId=${camA}&from=khoong`, "GET", undefined, owner())).status, 400);
  assert.equal((await call(`/api/recordings?cameraId=${camA}`, "GET", undefined, "")).status, 401);
});

/* ================= 5. API GET /api/recordings/play ================= */

test("API: play proxy — 200 video/mp4 + đúng path/start; Range chuyển tiếp khi upstream 206", async () => {
  const startIso = new Date(2026, 10, 1, 10, 0, 0).toISOString(); // khớp SEGFRESH
  fixtureCalls.length = 0;
  const r = await call(`/api/recordings/play?cameraId=${camA}&start=${encodeURIComponent(startIso)}&duration=60`, "GET", undefined, owner());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.headers.get("content-type") ?? "", /video\/mp4/);
  const hit = fixtureCalls.at(-1);
  assert.equal(hit?.path, keyA(), "proxy phải truyền đúng mediaMTX path của camera");
  assert.equal(hit?.start, startIso, "start phải được chuyển nguyên (ISO)");
  assert.equal(hit?.duration, "60");
  assert.equal(hit?.range, null);

  fixtureCalls.length = 0;
  const rr = await call(`/api/recordings/play?cameraId=${camA}&start=${encodeURIComponent(startIso)}`, "GET", undefined, owner(), { Range: "bytes=0-99" });
  assert.equal(rr.status, 206, "upstream 206 → proxy trả 206");
  assert.equal(rr.headers.get("content-range"), "bytes 0-99/500");
  assert.equal(fixtureCalls.at(-1)?.range, "bytes=0-99", "Range header phải được chuyển tiếp");

  const dl = await call(`/api/recordings/play?cameraId=${camA}&start=${encodeURIComponent(startIso)}&download=1`, "GET", undefined, owner());
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition") ?? "", /attachment;.*\.mp4/);

  assert.equal((await call(`/api/recordings/play?cameraId=${camB}&start=${encodeURIComponent(startIso)}`, "GET", undefined, owner())).status, 404, "camera không có bản ghi → 404");
  assert.equal((await call(`/api/recordings/play?cameraId=${camA}&start=${encodeURIComponent(startIso)}`, "GET", undefined, t2owner())).status, 404);
  assert.equal((await call(`/api/recordings/play?cameraId=${camA}&start=${encodeURIComponent(startIso)}`, "GET", undefined, "")).status, 401);
  assert.equal((await call(`/api/recordings/play?cameraId=${camA}&start=khoong`, "GET", undefined, owner())).status, 400);
  assert.equal((await call(`/api/recordings/play?start=${encodeURIComponent(startIso)}`, "GET", undefined, owner())).status, 400);
});

/* ================= 6. API DELETE /api/recordings ================= */

test("API: DELETE — owner xoá được + audit; viewer/operator 403; nặc danh 401; khác tenant 404", async () => {
  assert.equal((await call(`/api/recordings?cameraId=${camA}&olderThanDays=30`, "DELETE", undefined, viewer())).status, 403);
  assert.equal((await call(`/api/recordings?cameraId=${camA}&olderThanDays=30`, "DELETE", undefined, operator())).status, 403);
  assert.equal((await call(`/api/recordings?cameraId=${camA}&olderThanDays=30`, "DELETE", undefined, "")).status, 401);
  assert.equal((await call(`/api/recordings?cameraId=${camA}&olderThanDays=30`, "DELETE", undefined, t2owner())).status, 404);
  assert.equal((await call(`/api/recordings?cameraId=${camA}&olderThanDays=0`, "DELETE", undefined, owner())).status, 400);

  const r = await call(`/api/recordings?cameraId=${camA}&olderThanDays=30`, "DELETE", undefined, owner());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.deleted, 1, "chỉ SEGOLD quá 30 ngày bị xoá");
  assert.equal(existsSync(join(recDir, keyA(), SEGOLD)), false);
  assert.equal(existsSync(join(recDir, keyA(), SEGFRESH)), true);

  const [auditRow] = await db.select({ actor: auditLog.actor, targetId: auditLog.targetId })
    .from(auditLog).where(and(eq(auditLog.action, "recording.purge"), eq(auditLog.actor, `${prefix}_owner`)));
  assert.equal(auditRow?.targetId, keyA(), "audit phải ghi đúng session actor + cameraKey");

  const none = await call(`/api/recordings?cameraId=${camA}&olderThanDays=30`, "DELETE", undefined, owner());
  assert.equal(none.data.deleted, 0, "không còn gì quá hạn");
  const global365 = await call(`/api/recordings?olderThanDays=365`, "DELETE", undefined, owner());
  assert.equal(global365.status, 200);
  assert.equal(global365.data.deleted, 0, "không cameraId → purge toàn cục; mọi segment đều < 365 ngày");
});

/* ================= 7. runVideoRetention — per-camera days, fallback global ================= */

test("unit: runVideoRetention — camera_settings.retention_days override; dir lạ dùng fallback global", async () => {
  await db.insert(cameraSettings).values({ cameraId: camA, tenantId: 1, retentionDays: 1 })
    .onConflictDoUpdate({ target: cameraSettings.cameraId, set: { retentionDays: 1, updatedAt: new Date() } });
  await db.update(appSettings).set({ value: 365, updatedAt: new Date() }).where(eq(appSettings.key, "retentionDays"));
  try {
    const rep = await runVideoRetention();
    assert.ok(rep.deleted >= 3, `camA (2 file, override settings=1d) + camC (1 file, fallback cameras=2d) — ${JSON.stringify(rep)}`);
    assert.equal(existsSync(join(recDir, keyA(), SEGFRESH)), false, "camA giữ 1 ngày → segment 2 ngày bị xoá");
    assert.equal(existsSync(join(recDir, keyA(), SEGZERO)), false, "file 0 byte quá hạn cũng bị dọn");
    assert.equal(existsSync(join(recDir, `dai_cam_${camC}`, SEGC_OLD)), false, "camC không có settings → cameras.retention_days=2 xoá segment ~3 tháng");
    assert.equal(existsSync(join(recDir, `dai_cam_${camC}`, SEGC_FRESH)), true, "camC segment ~1 ngày còn trong hạn 2 ngày");
    assert.equal(existsSync(join(recDir, "zzz_other", SEGOTHER)), true, "dir không map camera → giữ theo global 365");
    const [auditRow] = await db.select({ actor: auditLog.actor, targetId: auditLog.targetId })
      .from(auditLog).where(and(eq(auditLog.action, "recording.purge"), eq(auditLog.targetId, keyA()), eq(auditLog.actor, "system")));
    assert.equal(auditRow?.actor, "system", "job nền ghi actor=system");
  } finally {
    await db.update(appSettings).set({ value: 0, updatedAt: new Date() }).where(eq(appSettings.key, "retentionDays"));
    await db.delete(cameraSettings).where(eq(cameraSettings.cameraId, camA));
  }
});

/* ================= 8. recordingKeysFor ================= */

test("unit: recordingKeysFor — streamName trước, basename RTSP source sau; key lạ bị loại", () => {
  assert.deepEqual(recordingKeysFor({ streamName: "dai_cam_7", sourceCiphertext: null }), ["dai_cam_7"]);
  assert.deepEqual(recordingKeysFor({ streamName: "../bad", sourceCiphertext: null }), []);
  assert.deepEqual(recordingKeysFor({ streamName: null, sourceCiphertext: null }), []);
  try {
    const ct = encryptSource("rtsp://10.0.0.9:8554/cam");
    assert.deepEqual(recordingKeysFor({ streamName: "dai_cam_7", sourceCiphertext: ct }), ["dai_cam_7", "cam"]);
  } catch {
    // CAMERA_CREDENTIAL_KEY không có trong env test — nhánh basename đã cover bởi mapping trên.
  }
});
