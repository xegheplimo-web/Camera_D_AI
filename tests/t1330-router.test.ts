import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import { db, pool } from "../src/db";
import { aiServices, auditLog } from "../src/db/schema";
import { routeQuestion } from "../src/lib/ai/routing";
import { PROFILES, adapterState, markProfile, pickAdapter, profileAvailable, resolveProfile, type TaskType } from "../src/lib/ai/orchestrator";
import { recordRoute } from "../src/lib/ai/telemetry";
import { gpuSlots, withGpuSlot } from "../src/lib/ai/gpu";

/**
 * T-1330 (PR1) — router nền: TaskType registry + breaker theo profile + telemetry
 * ai.route + GPU semaphore. Breaker/telemetry đi qua bảng ai_services/audit_log
 * thật (không migration mới); hàng profile:* và ai.route của test được dọn sau.
 */

const routeIds: number[] = [];

after(async () => {
  await db.delete(aiServices).where(like(aiServices.name, "profile:%"));
  for (const id of routeIds) await db.delete(auditLog).where(eq(auditLog.id, id));
  await pool.end();
}, { timeout: 20000 });

test("routeQuestion: nhận diện video.search trước luật ^tìm", () => {
  const r = routeQuestion("Tìm video có xe màu đỏ");
  assert.equal(r.path, "orchestrated");
  assert.equal(r.task, "video.search");
  for (const q of ["tìm clip lúc 20h hôm qua", "Có đoạn phim nào ghi xe vào?", "trích xuất video camera 2"]) {
    const d = routeQuestion(q);
    assert.equal(d.path, "orchestrated", q);
    assert.equal(d.task, "video.search", q);
  }
});

test("routeQuestion: truy vấn số liệu vẫn fast, không đổi hành vi cũ", () => {
  assert.equal(routeQuestion("Hôm nay có bao nhiêu xe vào?").path, "fast");
  assert.equal(routeQuestion("Giờ cao điểm 7 ngày qua là khi nào?").path, "fast");
  assert.equal(routeQuestion("Tìm cảnh báo trong kho tuần này").path, "fast");
  const deep = routeQuestion("Phân tích toàn bộ camera tuần trước, tìm bất thường và lập báo cáo");
  assert.equal(deep.path, "orchestrated");
  assert.equal(deep.task, "analysis.multi_step");
});

test("resolveProfile: đủ 12 TaskType theo registry; task lạ → UNKNOWN_TASK", () => {
  const tasks = Object.keys(PROFILES);
  assert.equal(tasks.length, 12, "registry phải có đúng 12 TaskType");
  for (const t of tasks) {
    const p = resolveProfile(t as TaskType);
    assert.equal(p.task, t);
    assert.ok(p.timeoutMs > 0 && p.concurrency > 0);
  }
  const err = (() => { try { resolveProfile("không_tồn_tại" as TaskType); return null; } catch (e) { return e as { code?: string }; } })();
  assert.ok(err);
  assert.equal(err.code, "UNKNOWN_TASK");
});

test("registry khớp bảng thiết kế: adapter + timeout của từng profile", () => {
  const expect: [TaskType, string, number][] = [
    ["data.query", "sql", 1000],
    ["analysis.multi_step", "hermes-glm", 15000],
    ["image.describe", "vision", 30000],
    ["video.summarize", "vision", 60000],
    ["video.search", "video-search", 10000],
    ["ocr.read", "ocr", 5000],
    ["plate.read", "ocr", 5000],
    ["text.embed", "embed-text", 3000],
    ["image.embed", "embed-image", 3000],
    ["speech.stt", "stt", 15000],
    ["speech.tts", "tts", 10000],
    ["object.count", "detector", 1000],
  ];
  for (const [task, adapter, timeoutMs] of expect) {
    const p = resolveProfile(task);
    assert.equal(p.adapter, adapter, task);
    assert.equal(p.timeoutMs, timeoutMs, task);
  }
  assert.equal(resolveProfile("data.query").asyncOnly, false);
  assert.equal(resolveProfile("video.search").asyncOnly, true);
});

test("adapterState: adapter local sẵn sàng, adapter chưa cấu hình/lạ → not_configured", async () => {
  assert.equal(await adapterState("sql"), "ready");
  assert.equal(await adapterState("video-search"), "not_configured"); // chưa có handler → không ready
  assert.equal(await adapterState("không-có"), "not_configured");
  const old = process.env.HERMES_BASE_URL;
  delete process.env.HERMES_BASE_URL;
  try { assert.equal(await adapterState("hermes-glm"), "not_configured"); }
  finally { if (old === undefined) delete process.env.HERMES_BASE_URL; else process.env.HERMES_BASE_URL = old; }
});

test("breaker theo profile: lỗi 1 profile mở cooldown, profile khác không bị ảnh hưởng", async () => {
  await markProfile("ocr.read", false, 120, "TIMEOUT");
  const [row] = await db.select().from(aiServices).where(eq(aiServices.name, "profile:ocr.read")).limit(1);
  assert.ok(row, "ai_services phải có dòng profile:ocr.read");
  assert.ok(row.cooldownUntil && row.cooldownUntil > new Date(), "cooldown_until > now sau khi lỗi");
  assert.equal(await profileAvailable("ocr.read"), false);
  assert.equal(await profileAvailable("video.search"), true, "profile khác không được khoá theo");
  const other = await pickAdapter("video.search");
  assert.equal(other.profile.adapter, "video-search");
  assert.equal(other.state, "not_configured");
  await markProfile("ocr.read", true, 50);
  assert.equal(await profileAvailable("ocr.read"), true, "lần gọi tốt đóng breaker lại");
});

test("telemetry ai.route: ghi audit_log, JSON gọn không chứa prompt/ảnh", async () => {
  const requestId = `t1330-${randomUUID()}`;
  await recordRoute(
    { taskType: "video.search", profile: "video.search", adapter: "video-search", model: null, latencyMs: 42, ok: true, fallbackUsed: false, consentState: "not_required", requestId },
    { name: "t1330-test", role: "owner", device: "test" },
  );
  // Lọc đúng dòng của test này: các test khác (serviceFetch) cũng ghi ai.route song song,
  // đọc "dòng mới nhất" toàn cục là race → flaky trên CI (đã đỏ ở run 41570192132 và 41572460569).
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "ai.route"), like(auditLog.detail, `%${requestId}%`)))
    .orderBy(desc(auditLog.id))
    .limit(1);
  assert.ok(row, "audit_log phải có dòng ai.route của chính test này");
  routeIds.push(row.id);
  assert.equal(row.actor, "t1330-test");
  const detail = JSON.parse(row.detail ?? "{}") as Record<string, unknown>;
  assert.equal(detail.requestId, requestId);
  assert.equal(detail.taskType, "video.search");
  assert.equal(detail.ok, true);
  for (const banned of ["prompt", "image", "question", "messages", "base64", "apiKey", "key", "secret"])
    assert.ok(!(banned in detail), `detail không được chứa ${banned}`);
});

test("withGpuSlot: một slot GPU serialize các tác vụ nặng", async () => {
  let concurrent = 0, peak = 0;
  const work = () => withGpuSlot(async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 20));
    concurrent--;
  });
  await Promise.all([work(), work(), work()]);
  assert.equal(peak, 1, "không bao giờ có 2 tác vụ GPU chạy song song");
  assert.equal(gpuSlots().active, 0);
  assert.equal(gpuSlots().waiting, 0);
});
