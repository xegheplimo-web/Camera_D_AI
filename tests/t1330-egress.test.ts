import "dotenv/config";
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, pool } from "../src/db";
import { aiServices, appSettings } from "../src/db/schema";
import { serviceConfig, serviceFetch, serviceStatus } from "../src/lib/ai/services";

/**
 * T-1330 (P0) — egress phải do server khai báo qua <PREFIX>_EGRESS, không suy từ
 * host loopback. Bridge 127.0.0.1 chuyển tiếp ra Internet vẫn là remote.
 * Không khai báo => remote (fail-safe). serviceFetch phải ném CONSENT_REQUIRED
 * trước khi phát bất kỳ request nào khi remoteProcessingAllowed=false.
 * DB thật (app_settings/ai_services) dùng snapshot/restore như ai-integration.
 */

const ENV_KEYS = [
  "HERMES_BASE_URL", "HERMES_API_KEY", "HERMES_MODEL", "HERMES_EGRESS",
  "DAI_VISION_BASE_URL", "DAI_VISION_API_KEY", "DAI_VISION_MODEL", "DAI_VISION_EGRESS",
  "DAI_OCR_BASE_URL", "DAI_OCR_API_KEY", "DAI_OCR_MODEL", "DAI_OCR_EGRESS",
  "DAI_VOICE_BASE_URL", "DAI_VOICE_API_KEY", "DAI_VOICE_EGRESS",
];
let envBefore: Record<string, string | undefined> = {};
let settingsBefore: (typeof appSettings.$inferSelect)[] = [];
let servicesBefore: (typeof aiServices.$inferSelect)[] = [];
const realFetch = globalThis.fetch;
let fetchCalls = 0;

function stubFetch() {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? "UNKNOWN"; }
}

before(async () => {
  envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  settingsBefore = await db.select().from(appSettings);
  servicesBefore = await db.select().from(aiServices);
  // Trạng thái consent mặc định của app: chưa cho phép xử lý từ xa.
  for (const [key, value] of [["remoteProcessingAllowed", false], ["hermesEnabled", true]] as const)
    await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  await db.delete(aiServices); // không có cooldown cũ che khuất kết quả
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k]!;
});

after(async () => {
  globalThis.fetch = realFetch;
  await db.delete(appSettings); if (settingsBefore.length) await db.insert(appSettings).values(settingsBefore);
  await db.delete(aiServices); if (servicesBefore.length) await db.insert(aiServices).values(servicesBefore);
  await pool.end();
}, { timeout: 20000 });

test("egress=remote trên loopback + remoteProcessingAllowed=false → CONSENT_REQUIRED (403), không phát request", async () => {
  process.env.HERMES_BASE_URL = "http://127.0.0.1:8791";
  process.env.HERMES_API_KEY = "fixture-key";
  process.env.HERMES_EGRESS = "remote";
  const c = serviceConfig("hermes");
  assert.equal(c?.egress, "remote");
  assert.equal(c?.remote, true, "egress remote phải làm remote=true kể cả host loopback");
  stubFetch();
  assert.equal(await codeOf(serviceFetch("hermes", "models")), "CONSENT_REQUIRED");
  const err = await serviceFetch("hermes", "models").catch((e) => e);
  assert.equal(err.httpStatus, 403);
  assert.equal(fetchCalls, 0, "không được phát request ra ngoài khi chưa consent");
});

test("egress=local trên loopback → cho phép, request đi bình thường", async () => {
  process.env.HERMES_BASE_URL = "http://127.0.0.1:8791";
  process.env.HERMES_API_KEY = "fixture-key";
  process.env.HERMES_EGRESS = "local";
  const c = serviceConfig("hermes");
  assert.equal(c?.egress, "local");
  assert.equal(c?.remote, false);
  stubFetch();
  const res = await serviceFetch("hermes", "models");
  assert.equal(res.status, 200);
  assert.equal(fetchCalls, 1);
});

test("không khai báo *_EGRESS → mặc định remote (fail-safe) và consent chặn cả loopback", async () => {
  process.env.HERMES_BASE_URL = "http://127.0.0.1:8791";
  process.env.HERMES_API_KEY = "fixture-key";
  delete process.env.HERMES_EGRESS;
  const c = serviceConfig("hermes");
  assert.equal(c?.egress, "remote", "thiếu khai báo phải coi như remote");
  assert.equal(c?.remote, true);
  stubFetch();
  assert.equal(await codeOf(serviceFetch("hermes", "models")), "CONSENT_REQUIRED");
  assert.equal(fetchCalls, 0);
});

test("egress=local không cứu được host ngoài LAN: remote vẫn đúng, HTTP ngoài LAN vẫn bắt TLS", () => {
  process.env.HERMES_BASE_URL = "https://ai.example.com";
  process.env.HERMES_API_KEY = "fixture-key";
  process.env.HERMES_EGRESS = "local";
  const c = serviceConfig("hermes");
  assert.equal(c?.egress, "local");
  assert.equal(c?.remote, true, "host ngoài mạng riêng luôn remote bất kể khai báo");
  process.env.HERMES_BASE_URL = "http://ai.example.com";
  assert.throws(() => serviceConfig("hermes"), (e) => (e as { code?: string }).code === "TLS_REQUIRED");
});

test("cả 4 dịch vụ đọc <PREFIX>_EGRESS độc lập", () => {
  process.env.HERMES_BASE_URL = "http://127.0.0.1:8791"; process.env.HERMES_API_KEY = "k"; process.env.HERMES_EGRESS = "remote";
  process.env.DAI_VISION_BASE_URL = "http://127.0.0.1:8791"; process.env.DAI_VISION_API_KEY = "k"; process.env.DAI_VISION_MODEL = "m"; process.env.DAI_VISION_EGRESS = "local";
  process.env.DAI_OCR_BASE_URL = "http://127.0.0.1:8791"; process.env.DAI_OCR_API_KEY = "k"; process.env.DAI_OCR_MODEL = "m"; process.env.DAI_OCR_EGRESS = "local";
  process.env.DAI_VOICE_BASE_URL = "http://127.0.0.1:8791"; process.env.DAI_VOICE_API_KEY = "k"; process.env.DAI_VOICE_EGRESS = "remote";
  assert.equal(serviceConfig("hermes")?.egress, "remote");
  assert.equal(serviceConfig("vision")?.egress, "local");
  assert.equal(serviceConfig("ocr")?.egress, "local");
  assert.equal(serviceConfig("voice")?.egress, "remote");
  assert.equal(serviceConfig("voice")?.remote, true);
});

test("serviceStatus() trả egress đúng cho UI: khai báo local vs mặc định remote", async () => {
  process.env.HERMES_BASE_URL = "http://127.0.0.1:8791"; process.env.HERMES_API_KEY = "k"; process.env.HERMES_EGRESS = "local";
  process.env.DAI_VISION_BASE_URL = "http://127.0.0.1:8791"; process.env.DAI_VISION_API_KEY = "k"; process.env.DAI_VISION_MODEL = "m";
  delete process.env.DAI_VISION_EGRESS;
  const status = await serviceStatus();
  assert.equal(status.find((s) => s.name === "hermes")?.egress, "local");
  const vision = status.find((s) => s.name === "vision");
  assert.equal(vision?.egress, "remote");
  assert.equal(vision?.remote, true);
});

test("bridge loopback không cần API key ở phía app; consent vẫn chặn theo egress", async () => {
  // Thực tế .env.local: DAI_VISION_BASE_URL=127.0.0.1:8791, KHÔNG có DAI_VISION_API_KEY.
  // Thiếu key không được biến thành MISSING_API_KEY; nhưng egress=remote vẫn phải qua consent.
  process.env.DAI_VISION_BASE_URL = "http://127.0.0.1:8791";
  process.env.DAI_VISION_MODEL = "glm-5.3-flash";
  delete process.env.DAI_VISION_API_KEY;
  delete process.env.DAI_VISION_EGRESS;
  const c = serviceConfig("vision");
  assert.equal(c?.egress, "remote");
  assert.equal(c?.remote, true);
  assert.equal(c?.key, "");
  stubFetch();
  assert.equal(await codeOf(serviceFetch("vision", "chat/completions")), "CONSENT_REQUIRED");
  assert.equal(fetchCalls, 0, "chưa consent thì không được gọi bridge");
});
