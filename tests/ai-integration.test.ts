import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync, randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { db, pool } from "../src/db";
import { users, cameras, events, assets, messages, aiJobs, aiServices, sessions, extractions, appSettings, auditLog } from "../src/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { enqueueJob } from "../src/lib/ai/jobs";
import { verifyToken, type SessionPayload } from "../src/lib/token";

// Contract fixture only: no actual Hermes, GPU, OCR model or speaker is exercised here.
const prefix = `contract_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const serviceKey = randomBytes(32).toString("hex");
const dispatchKey = randomBytes(32).toString("hex");
const state = { hermesDown: false, unsafe: false, invalidPlan: false, slowVision: 0, invalidVision: false, visionDown: false, visionAttempts: 0, hermesCalls: 0, visionCalls: 0, ocrCalls: 0, cropWidth: 0 };
let fixture: Server, app: ChildProcess, base: string, ownerCookie = "", viewerCookie = "", ownerSession: SessionPayload;
let userIds: number[] = [], camId: number, assetId: number;
let settingsBefore: (typeof appSettings.$inferSelect)[] = [], healthBefore: (typeof aiServices.$inferSelect)[] = [];
let logs = "";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ids: string[] = [];
async function port() { const s = createServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); const n = (s.address() as { port: number }).port; await new Promise<void>((r) => s.close(() => r())); return n; }
async function call(path: string, method = "GET", body?: unknown, cookie = ownerCookie, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const raw = await response.text();
  let data: any; try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 300) }; }
  return { status: response.status, data, headers: response.headers };
}
async function login(role: string) {
  const r = await call("/api/auth/login", "POST", { login: `${prefix}_${role}`, password }, "");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.headers.get("set-cookie")!.split(";")[0];
}
async function settle(id: string) {
  ids.push(id);
  for (let i = 0; i < 100; i++) {
    const r = await call(`/api/jobs/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (["succeeded", "partial", "failed", "cancelled"].includes(r.data.job.state)) return r.data;
    await wait(100);
  }
  throw new Error(`Job ${id} did not settle. ${logs.slice(-2000)}`);
}
async function clearBreaker() { await db.delete(aiServices).where(inArray(aiServices.name, ["hermes", "vision", "ocr", "voice"])); }

before(async () => {
  settingsBefore = await db.select().from(appSettings);
  healthBefore = await db.select().from(aiServices);
  for (const [key, value] of [["hermesEnabled", true], ["remoteProcessingAllowed", false], ["demoMode", false]] as const)
    await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  const inserted = await db.insert(users).values(["owner", "operator", "viewer"].map((role) => ({ login: `${prefix}_${role}`, displayName: `${prefix}_${role}`, role, passwordHash }))).returning();
  userIds = inserted.map((u) => u.id);
  const [camera] = await db.insert(cameras).values({ code: prefix, name: prefix, location: "Fixture SQL", sourceType: "demo", status: "demo" }).returning();
  camId = camera.id;
  await db.update(cameras).set({ code: `CAM-${String(camId).padStart(2, "0")}` }).where(eq(cameras.id, camId));
  const image = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#102030" } }).jpeg().toBuffer();
  const [asset] = await db.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: createHash("sha256").update(image).digest("hex"), data: image.toString("base64"), width: 640, height: 360, uploadedBy: `${prefix}_owner`, origin: "upload", cameraId: camId }).returning();
  assetId = asset.id;
  await db.insert(events).values([
    ...Array.from({ length: 4 }, () => ({ cameraId: camId, type: "person_in", label: prefix, source: "manual", clientReported: false, assetId })),
    { cameraId: camId, type: "person_out", label: prefix, source: "manual", clientReported: false, assetId },
    { cameraId: camId, type: "alert", label: prefix, source: "manual", clientReported: false, assetId, priority: "critical" },
    { cameraId: camId, type: "person_in", label: prefix, source: "live", clientReported: true, assetId },
  ]);
  fixture = createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.headers.authorization !== `Bearer ${serviceKey}`) { res.writeHead(401).end(); return; }
    if (url.endsWith("/models")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "contract-fixture" }] })); return; }
    if (url.includes("/hermes/") && state.hermesDown) { res.writeHead(503).end(); return; }
    if (url.includes("/vision/") && req.method === "POST") { state.visionAttempts++; if (state.visionDown) { res.writeHead(503).end(); return; } }
    if (url.endsWith("/toolsets")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(state.unsafe ? [{ enabled: true, tools: ["terminal"] }] : [])); return; }
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
    if (url.endsWith("/audio/transcriptions")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ text: "Hôm nay có bao nhiêu khách?" })); return; }
    if (url.endsWith("/audio/speech")) { res.setHeader("Content-Type", "audio/mpeg"); res.end(Buffer.from([0x49, 0x44, 0x33, 0, 0, 0])); return; }
    const b = JSON.parse(Buffer.concat(chunks).toString());
    let content: unknown;
    if (url.includes("/hermes/")) {
      state.hermesCalls++;
      const q = JSON.parse(b.messages.at(-1).content);
      content = state.invalidPlan ? { tools: ["terminal"], sql: "DROP TABLE events" } : { tools: q.task === "report" ? ["memory.summary", "memory.events"] : ["vision.extract", "ocr.extract"] };
    } else {
      const isOcr = url.includes("/ocr/");
      if (isOcr) state.ocrCalls++; else state.visionCalls++;
      const src = b.messages.at(-1).content.find((x: { type: string }) => x.type === "image_url").image_url.url;
      state.cropWidth = (await sharp(Buffer.from(src.split(",")[1], "base64")).metadata()).width ?? 0;
      if (!isOcr && state.slowVision) await wait(state.slowVision);
      content = state.invalidVision ? { summary: "missing fields" } : {
        summary: isOcr ? "Fixture OCR: nhãn A1" : "Fixture Vision: 7 hộp; đây không phải kết quả model thực.", details: [],
        objects: isOcr ? [] : [{ label: "hộp", count: 7, confidence: 0.8, boxes: [[0.1, 0.1, 0.2, 0.2]] }],
        ocrText: isOcr ? "A1" : "", structured: [], confidence: 0.8, warnings: ["Contract fixture, không phải benchmark AI"],
      };
    }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const appPort = await port(); base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: { ...process.env,
    HERMES_BASE_URL: `${root}/hermes/v1`, HERMES_API_KEY: serviceKey, HERMES_EGRESS: "local",
    DAI_VISION_BASE_URL: `${root}/vision/v1`, DAI_VISION_MODEL: "contract-vision", DAI_VISION_API_KEY: serviceKey, DAI_VISION_EGRESS: "local",
    DAI_OCR_BASE_URL: `${root}/ocr/v1`, DAI_OCR_MODEL: "contract-ocr", DAI_OCR_API_KEY: serviceKey, DAI_OCR_EGRESS: "local",
    DAI_VOICE_BASE_URL: `${root}/voice/v1`, DAI_VOICE_STT_MODEL: "contract-stt", DAI_VOICE_TTS_MODEL: "contract-tts", DAI_VOICE_API_KEY: serviceKey, DAI_VOICE_EGRESS: "local",
    DAI_DISPATCH_TOKEN: dispatchKey, DAI_AI_TIMEOUT_MS: "1500", NODE_ENV: "production",
  }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  ownerCookie = await login("owner"); viewerCookie = await login("viewer");
  ownerSession = (await verifyToken(ownerCookie.slice(ownerCookie.indexOf("=") + 1)))!;
  await clearBreaker();
}, { timeout: 30000 });

after(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  if (fixture) await new Promise<void>((r) => fixture.close(() => r()));
  if (userIds.length) {
    await db.delete(aiJobs).where(inArray(aiJobs.userId, userIds));
    await db.delete(messages).where(inArray(messages.userId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(extractions).where(like(extractions.createdBy, `${prefix}%`));
    await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
    if (camId) { await db.delete(events).where(eq(events.cameraId, camId)); await db.delete(assets).where(eq(assets.cameraId, camId)); await db.delete(cameras).where(eq(cameras.id, camId)); }
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await db.delete(appSettings); if (settingsBefore.length) await db.insert(appSettings).values(settingsBefore);
  await db.delete(aiServices); if (healthBefore.length) await db.insert(aiServices).values(healthBefore);
  await pool.end();
}, { timeout: 20000 });

test("Gateway + Hermes/Worker contracts (isolated API fixtures)", { timeout: 180000 }, async (t) => {
  await t.test("unauthenticated, viewer write and cross-origin requests fail closed", async () => {
    assert.equal((await call("/api/jobs", "GET", undefined, "")).status, 401);
    assert.equal((await call("/api/orchestration", "POST", { action: "probe", service: "hermes" }, viewerCookie)).status, 403);
    assert.equal((await call("/api/extractions", "POST", { assetId, note: "x" }, viewerCookie)).status, 403);
    assert.equal((await call("/api/chat", "POST", { question: "x" }, ownerCookie, { Origin: "https://not-our-origin.example" })).status, 403);
    assert.equal((await call("/api/internal/jobs/dispatch", "POST", undefined, "", { Authorization: "Bearer wrong" })).status, 401);
  });
  await t.test("SQL answer never calls Hermes; unreviewed client counts are excluded", async () => {
    const before = state.hermesCalls;
    const q = `Hôm nay Camera ${camId} có bao nhiêu khách?`;
    const r = await call("/api/chat", "POST", { question: q, requestId: randomUUID() });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.assistant.answer.value, 4);
    assert.equal(r.data.assistant.answer.execution.path, "fast"); assert.equal(state.hermesCalls, before);
    const spoof = await call("/api/events", "POST", { cameraId: camId, type: "person_in", label: prefix, clientReported: false });
    assert.equal(spoof.data.clientReported, true);
    const again = await call("/api/chat", "POST", { question: q, requestId: randomUUID() }); assert.equal(again.data.assistant.answer.value, 4);
  });
  await t.test("fast question replay does not duplicate history and conflicts are rejected", async () => {
    const requestId = randomUUID(), question = `Camera ${camId} hôm nay có bao nhiêu khách?`;
    const a = await call("/api/chat", "POST", { requestId, question }); const b = await call("/api/chat", "POST", { requestId, question });
    assert.equal(a.data.assistant.id, b.data.assistant.id);
    assert.equal((await call("/api/chat", "POST", { requestId, question: "Câu hỏi khác" })).status, 409);
  });
  await t.test("deep request gets a durable plan, SQL facts and only real evidence IDs", async () => {
    const requestId = randomUUID(), question = `Phân tích Camera ${camId} hôm nay, tìm bất thường và lập báo cáo`;
    const [a, b] = await Promise.all([call("/api/chat", "POST", { requestId, question }), call("/api/chat", "POST", { requestId, question })]);
    assert.equal(a.status, 202, JSON.stringify(a.data)); assert.equal(a.data.job.id, b.data.job.id);
    const r = await settle(a.data.job.id); assert.equal(r.job.state, "succeeded", JSON.stringify(r.job)); assert.equal(r.job.route, "hermes");
    assert.equal(r.assistant.answer.calculation.totals.entries, 4); assert.equal(r.assistant.answer.calculation.totals.demo, 0);
    assert.ok(r.assistant.answer.warnings.some((w: string) => w.includes("chưa phân tích lại video")));
    assert.ok(r.assistant.answer.evidence.every((e: { eventId: number }) => Number.isInteger(e.eventId)));
    assert.equal((await call(`/api/jobs/${a.data.job.id}`, "GET", undefined, viewerCookie)).status, 404);
    const history = await call("/api/chat", "GET", undefined, viewerCookie); assert.equal(history.data.length, 0);
  });
  await t.test("Hermes offline gives explicitly partial SQL report; fast path still works", async () => {
    await clearBreaker(); state.hermesDown = true;
    const deep = await call("/api/chat", "POST", { requestId: randomUUID(), question: `Phân tích Camera ${camId} hôm nay` });
    const result = await settle(deep.data.job.id); assert.equal(result.job.state, "partial"); assert.equal(result.job.route, "fallback");
    assert.equal(result.assistant.answer.calculation.totals.entries, 4);
    assert.ok(result.assistant.answer.warnings.some((w: string) => w.includes("Trợ lý AI chưa sẵn sàng")));
    const quick = await call("/api/chat", "POST", { requestId: randomUUID(), question: `Camera ${camId} hôm nay có bao nhiêu khách?` }); assert.equal(quick.status, 200); assert.equal(quick.data.assistant.answer.value, 4);
    state.hermesDown = false; await clearBreaker();
  });
  await t.test("unsafe Hermes profile and arbitrary tool plans are rejected", async () => {
    state.unsafe = true; const before = state.hermesCalls;
    const a = await call("/api/chat", "POST", { requestId: randomUUID(), question: `Phân tích Camera ${camId} hôm nay` });
    const ra = await settle(a.data.job.id); assert.equal(ra.job.state, "partial"); assert.match(ra.job.error, /UNSAFE_HERMES_PROFILE/); assert.equal(state.hermesCalls, before);
    state.unsafe = false; state.invalidPlan = true;
    const b = await call("/api/chat", "POST", { requestId: randomUUID(), question: `Phân tích Camera ${camId} hôm nay` });
    const rb = await settle(b.data.job.id); assert.equal(rb.job.state, "partial"); assert.match(rb.job.error, /INVALID_PLAN|FORBIDDEN_TOOL/);
    state.invalidPlan = false; await clearBreaker();
  });
  await t.test("single extraction bypasses Hermes; server crops ROI and ignores client numbers", async () => {
    const before = state.hermesCalls;
    const r = await call("/api/extractions", "POST", { assetId, requestId: randomUUID(), note: "Đếm 12 hộp", taskType: "object_count", roi: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, local: { detections: [{ label: "box", count: 12 }] } });
    assert.equal(r.status, 202, JSON.stringify(r.data)); const result = await settle(r.data.job.id);
    assert.equal(result.job.route, "worker"); assert.equal(result.job.state, "succeeded", JSON.stringify(result.job));
    assert.equal(state.hermesCalls, before); assert.equal(state.cropWidth, 320);
    assert.equal(result.extraction.result.objects[0].count, 7); assert.equal(result.extraction.status, "REVIEW_REQUIRED"); assert.equal(result.extraction.verifiedAt, null);
    const edited = structuredClone(result.extraction.result); edited.objects[0].count = 8;
    const verified = await call(`/api/extractions/${result.extraction.id}`, "PATCH", { action: "verify", result: edited });
    assert.equal(verified.data.rawResult.objects[0].count, 7); assert.equal(verified.data.result.objects[0].count, 8);
    assert.equal((await call(`/api/jobs/${result.job.id}`, "PATCH", { action: "retry" })).status, 409);
  });
  await t.test("multi-tool extraction merges OCR without summing duplicate object counts", async () => {
    const a = await call("/api/extractions", "POST", { assetId, requestId: randomUUID(), note: "Đếm hộp, đọc mã trên nhãn và lập bảng", taskType: "freeform" });
    const result = await settle(a.data.job.id); assert.equal(result.job.route, "hermes"); assert.equal(result.extraction.result.objects[0].count, 7); assert.equal(result.extraction.result.ocrText, "A1"); assert.ok(state.ocrCalls > 0);
  });
  await t.test("direct note save needs no Hermes or worker", async () => {
    const before = state.hermesCalls + state.visionCalls + state.ocrCalls;
    const draft = await call("/api/extractions", "POST", { action: "draft", assetId, note: "Ghi chú fixture không cần AI" });
    assert.equal(draft.status, 201); assert.equal(draft.data.status, "DRAFT"); assert.equal(draft.data.result, null);
    assert.equal(state.hermesCalls + state.visionCalls + state.ocrCalls, before);
    assert.equal((await call(`/api/extractions/${draft.data.id}`, "PATCH", { action: "verify" })).status, 409);
  });
  await t.test("invalid ROI / worker JSON never becomes verified data; retry works", async () => {
    assert.equal((await call("/api/extractions", "POST", { assetId, note: "test", roi: { x: 0.9, y: 0, w: 0.5, h: 1 } })).status, 400);
    state.invalidVision = true;
    const a = await call("/api/extractions", "POST", { assetId, requestId: randomUUID(), note: "Đếm hộp", taskType: "object_count" });
    const bad = await settle(a.data.job.id); assert.equal(bad.job.state, "failed"); assert.equal(bad.extraction.rawResult, null);
    state.invalidVision = false;
    assert.equal((await call(`/api/jobs/${a.data.job.id}`, "PATCH", { action: "retry" })).status, 200);
    const good = await settle(a.data.job.id); assert.equal(good.job.state, "succeeded"); assert.equal(good.job.attempts, 2);
  });
  await t.test("cancel suppresses late worker results", async () => {
    state.slowVision = 700; const before = state.visionCalls;
    const a = await call("/api/extractions", "POST", { assetId, requestId: randomUUID(), note: "Đếm hộp", taskType: "object_count" });
    for (let i = 0; i < 40 && state.visionCalls === before; i++) { await call(`/api/jobs/${a.data.job.id}`); await wait(25); }
    assert.equal((await call(`/api/jobs/${a.data.job.id}`, "PATCH", { action: "cancel" })).status, 200);
    await wait(900); const cancelled = await settle(a.data.job.id);
    assert.equal(cancelled.job.state, "cancelled"); assert.equal(cancelled.extraction.rawResult, null); state.slowVision = 0; await clearBreaker();
  });
  await t.test("worker timeout is surfaced and no fake result is saved", async () => {
    state.slowVision = 3000;
    const a = await call("/api/extractions", "POST", { assetId, requestId: randomUUID(), note: "Đếm hộp", taskType: "object_count" });
    const timed = await settle(a.data.job.id); assert.equal(timed.job.state, "failed"); assert.equal(timed.extraction.result, null);
    assert.ok(timed.job.steps.some((s: { note?: string }) => s.note?.includes("TIMEOUT")));
    state.slowVision = 0; await clearBreaker();
  });
  await t.test("stale DB lease resumes safely using the same request identity", async () => {
    const { job } = await enqueueJob("report", { question: `Phân tích Camera ${camId} hôm nay`, demoMode: false, allowRemote: false, asOf: new Date().toISOString() }, ownerSession, `recovery:${randomUUID()}`);
    await db.update(aiJobs).set({ state: "running", attempts: 1, runToken: "expired-run", leaseUntil: new Date(Date.now() - 1000) }).where(eq(aiJobs.id, job.id));
    const recovered = await settle(job.id); assert.equal(recovered.job.state, "succeeded"); assert.equal(recovered.job.attempts, 2);
  });
  await t.test("two heavy jobs do not block SQL; third job waits for a free lease", async () => {
    state.slowVision = 700;
    const created = [];
    for (let i = 0; i < 3; i++) created.push(await call("/api/extractions", "POST", { assetId, requestId: randomUUID(), note: "Đếm hộp", taskType: "object_count" }));
    const active = await db.select().from(aiJobs).where(and(eq(aiJobs.userId, userIds[0]), eq(aiJobs.state, "running")));
    assert.ok(active.length <= 2);
    const queued = await call(`/api/jobs/${created[2].data.job.id}`); assert.equal(queued.data.job.state, "queued");
    const quick = await call("/api/chat", "POST", { question: `Camera ${camId} hôm nay có bao nhiêu khách?`, requestId: randomUUID() });
    assert.equal(quick.status, 200); assert.equal(quick.data.assistant.answer.execution.path, "fast");
    for (const response of created) assert.equal((await settle(response.data.job.id)).job.state, "succeeded");
    state.slowVision = 0;
  });
  await t.test("failed task stops after three attempts", async () => {
    state.invalidVision = true;
    const a = await call("/api/extractions", "POST", { assetId, requestId: randomUUID(), note: "Đếm hộp", taskType: "object_count" });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await settle(a.data.job.id); assert.equal(result.job.state, "failed"); assert.equal(result.job.attempts, attempt);
      if (attempt < 3) assert.equal((await call(`/api/jobs/${a.data.job.id}`, "PATCH", { action: "retry" })).status, 200);
    }
    assert.equal((await call(`/api/jobs/${a.data.job.id}`, "PATCH", { action: "retry" })).status, 409);
    state.invalidVision = false;
  });
  await t.test("circuit breaker prevents repeated network calls after two upstream failures", async () => {
    await clearBreaker(); state.visionDown = true;
    for (let i = 0; i < 2; i++) {
      const a = await call("/api/extractions", "POST", { assetId, requestId: randomUUID(), note: "Đếm hộp", taskType: "object_count" });
      assert.equal((await settle(a.data.job.id)).job.state, "failed");
    }
    const before = state.visionAttempts;
    const blocked = await call("/api/extractions", "POST", { assetId, requestId: randomUUID(), note: "Đếm hộp", taskType: "object_count" });
    const result = await settle(blocked.data.job.id); assert.equal(result.job.state, "failed");
    assert.equal(state.visionAttempts, before); assert.ok(result.job.steps.some((s: { note?: string }) => s.note?.includes("CIRCUIT_OPEN")));
    state.visionDown = false; await clearBreaker();
  });
  await t.test("voice proxy returns requester-device audio, STT text and does not call Hermes", async () => {
    const before = state.hermesCalls;
    const speech = await fetch(base + "/api/voice/tts", { method: "POST", headers: { Cookie: ownerCookie, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Fixture TTS", targetDevice: "someone-else" }) });
    assert.equal(speech.status, 200); assert.equal(speech.headers.get("x-output-target"), "requester_device"); await speech.arrayBuffer();
    const form = new FormData(); form.append("file", new Blob([Buffer.from("RIFF" + "fixture audio".repeat(5))], { type: "audio/wav" }), "fixture.wav");
    const stt = await fetch(base + "/api/voice/transcriptions", { method: "POST", headers: { Cookie: ownerCookie }, body: form });
    assert.equal(stt.status, 200); assert.equal((await stt.json()).source, "voice-worker"); assert.equal(state.hermesCalls, before);
  });
  await t.test("revoked sessions cannot read jobs or media", async () => {
    assert.equal((await call("/api/auth/logout", "POST", {}, viewerCookie)).status, 200);
    assert.equal((await call("/api/jobs", "GET", undefined, viewerCookie)).status, 401);
    assert.equal((await call(`/api/assets/${assetId}`, "GET", undefined, viewerCookie)).status, 401);
  });
});
