import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { ensureDefaultTenant } from "./helpers/tenant";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import sharp from "sharp";
import { db, pool } from "../src/db";
import {
  users, tenants, cameras, assets, sessions, auditLog,
  aiJobs, aiServices, extractions, knowledgeItems, appSettings,
} from "../src/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { enqueueJob, runJob } from "../src/lib/ai/jobs";
import { verifyToken, type SessionPayload } from "../src/lib/token";

/**
 * T-1337 — asset↔camera + index async idempotent + search trong scope.
 * Job asset.index chạy IN-PROCESS qua runJob() để test kiểm soát env/fixture/consent;
 * server `next start` được spawn KHÔNG có DAI_* env (POST /api/assets chỉ enqueue,
 * không auto-dispatch) nên phía server không thể chạy job của test.
 * Fixture AI: endpoint OpenAI-compatible trả text chứa token `uniq` để search.
 */
const prefix = `t1337_${randomBytes(5).toString("hex")}`;
const uniq = `${prefix}_uniq`;
const password = randomBytes(24).toString("hex");
const serviceKey = randomBytes(32).toString("hex");
const ENV_KEYS = [
  "DAI_OCR_BASE_URL", "DAI_OCR_MODEL", "DAI_OCR_API_KEY", "DAI_OCR_EGRESS",
  "DAI_VISION_BASE_URL", "DAI_VISION_MODEL", "DAI_VISION_API_KEY", "DAI_VISION_EGRESS",
];
let envBefore: Record<string, string | undefined> = {};
let settingsBefore: (typeof appSettings.$inferSelect)[] = [];
let servicesBefore: (typeof aiServices.$inferSelect)[] = [];

let fixture: Server, app: ChildProcess, base: string;
const cookies: Record<string, string> = {};
const userIds: number[] = [];
const assetIds: number[] = [];
const itemIds: number[] = [];
let t2id = 0, camA = 0, camB = 0, camC = 0;
let ownerSession: SessionPayload;
let logs = "";
const state = { down: false, calls: 0 };
const realFetch = globalThis.fetch;
const call: Call = makeCall(() => base, () => realFetch);

const owner = () => cookies.owner;
const viewer = () => cookies.viewer;
const t2owner = () => cookies.t2owner;
async function login(who: string) {
  cookies[who] = await loginUser(call, prefix, password, who);
}
async function jpeg(seed: number) {
  const buf = await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: (seed * 37) % 250, g: (seed * 91) % 250, b: (seed * 53) % 250 } } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString("base64")}`;
}
async function postAsset(body: Record<string, unknown>, cookie = owner()) {
  const r = await call("/api/assets", "POST", body, cookie);
  if (r.status === 201) assetIds.push(r.data.id);
  return r;
}
async function indexJobOf(assetId: number) {
  const rows = await db.select().from(aiJobs).where(eq(aiJobs.idempotencyKey, `asset:${assetId}`));
  assert.equal(rows.length, 1, `phải có đúng 1 job asset.index cho asset ${assetId}`);
  assert.equal(rows[0].kind, "asset.index");
  return rows[0];
}
const clearBreaker = () => db.delete(aiServices).where(inArray(aiServices.name, ["ocr", "vision"]));

before(async () => {
  envBefore = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  settingsBefore = await db.select().from(appSettings);
  servicesBefore = await db.select().from(aiServices);
  for (const [key, value] of [["remoteProcessingAllowed", false], ["demoMode", false], ["hermesEnabled", true]] as const)
    await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });

  fixture = createServer(async (req, res) => {
    state.calls++;
    if (req.headers.authorization !== `Bearer ${serviceKey}`) { res.writeHead(401).end(); return; }
    for await (const _ of req) void _;
    if (state.down) { res.writeHead(500).end("fixture down"); return; }
    const content = {
      summary: `Fixture chỉ mục ${uniq}`,
      details: [], objects: [],
      ocrText: `tem nhan ${uniq}`,
      structured: [{ key: "Nhãn", value: uniq, confidence: 0.9 }],
      confidence: 0.8, warnings: ["contract fixture"],
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  process.env.DAI_OCR_BASE_URL = `${root}/ocr/v1`; process.env.DAI_OCR_MODEL = "fixture-ocr"; process.env.DAI_OCR_API_KEY = serviceKey; process.env.DAI_OCR_EGRESS = "local";
  process.env.DAI_VISION_BASE_URL = `${root}/vision/v1`; process.env.DAI_VISION_MODEL = "fixture-vision"; process.env.DAI_VISION_API_KEY = serviceKey; process.env.DAI_VISION_EGRESS = "local";

  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  await ensureDefaultTenant();
  const [t2] = await db.insert(tenants).values({ slug: `${prefix}-t2`, name: `${prefix} tenant 2` }).returning();
  t2id = t2.id;
  const inserted = await db.insert(users).values([
    { login: `${prefix}_owner`, displayName: `${prefix}_owner`, role: "owner", passwordHash },
    { login: `${prefix}_operator`, displayName: `${prefix}_operator`, role: "operator", passwordHash },
    { login: `${prefix}_viewer`, displayName: `${prefix}_viewer`, role: "viewer", passwordHash },
    { login: `${prefix}_t2owner`, displayName: `${prefix}_t2owner`, role: "owner", passwordHash, tenantId: t2id },
  ]).returning();
  userIds.push(...inserted.map((u) => u.id));

  const [ca] = await db.insert(cameras).values({ code: `${prefix}-a`, name: `${prefix} cam A`, location: "Fixture", sourceType: "demo", status: "demo" }).returning();
  const [cb] = await db.insert(cameras).values({ code: `${prefix}-b`, name: `${prefix} cam B`, location: "Fixture", sourceType: "demo", status: "demo" }).returning();
  const [cc] = await db.insert(cameras).values({ code: `${prefix}-c`, name: `${prefix} cam C (t2)`, location: "Fixture", sourceType: "demo", status: "demo", tenantId: t2id }).returning();
  camA = ca.id; camB = cb.id; camC = cc.id;

  const appPort = await freePort(); base = `http://localhost:${appPort}`;
  const appEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
  for (const k of ENV_KEYS) delete appEnv[k];
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await realFetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  for (const who of ["owner", "operator", "viewer", "t2owner"]) await login(who);
  ownerSession = (await verifyToken(owner().slice(owner().indexOf("=") + 1)))!;
  await clearBreaker();
}, { timeout: 60000 });

after(async () => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) if (envBefore[k] === undefined) delete process.env[k]; else process.env[k] = envBefore[k]!;
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  if (fixture) await new Promise<void>((r) => fixture.close(() => r()));
  if (userIds.length) {
    await db.delete(aiJobs).where(inArray(aiJobs.userId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
  }
  if (itemIds.length) await db.delete(knowledgeItems).where(inArray(knowledgeItems.id, itemIds));
  if (assetIds.length) await db.delete(extractions).where(inArray(extractions.assetId, assetIds));
  await db.delete(extractions).where(like(extractions.createdBy, `${prefix}%`));
  if (camA || camB || camC) await db.delete(cameras).where(inArray(cameras.id, [camA, camB, camC].filter(Boolean)));
  if (assetIds.length) await db.delete(assets).where(inArray(assets.id, assetIds));
  // users xoá sau cùng: assets/extractions tham chiếu users.id bằng FK.
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
  await db.delete(appSettings); if (settingsBefore.length) await db.insert(appSettings).values(settingsBefore);
  await db.delete(aiServices); if (servicesBefore.length) await db.insert(aiServices).values(servicesBefore);
  if (t2id) await db.delete(tenants).where(eq(tenants.id, t2id));
  await pool.end();
}, { timeout: 20000 });

/* ================= 1. cameraId lưu đúng + GET ?cameraId= lọc ================= */

let a1 = 0, a2 = 0, a3 = 0, aT2 = 0;

test("POST asset có cameraId hợp lệ ⇒ assets.camera_id đúng; GET ?cameraId= chỉ trả ảnh của camera đó", async () => {
  const p1 = await postAsset({ dataUrl: await jpeg(1), width: 96, height: 64, origin: "capture", cameraId: camA });
  assert.equal(p1.status, 201, JSON.stringify(p1.data));
  a1 = p1.data.id;
  const [row] = await db.select({ cameraId: assets.cameraId }).from(assets).where(eq(assets.id, a1));
  assert.equal(row.cameraId, camA, "asset phải lưu camera_id của request");

  const p2 = await postAsset({ dataUrl: await jpeg(2), width: 96, height: 64, origin: "capture", cameraId: camB });
  assert.equal(p2.status, 201, JSON.stringify(p2.data));
  a2 = p2.data.id;
  const p3 = await postAsset({ dataUrl: await jpeg(3), width: 96, height: 64, origin: "upload" });
  assert.equal(p3.status, 201, JSON.stringify(p3.data));
  a3 = p3.data.id;

  const byCamA = await call(`/api/assets?cameraId=${camA}`, "GET", undefined, owner());
  assert.equal(byCamA.status, 200, JSON.stringify(byCamA.data));
  const idsA = (byCamA.data as any[]).map((r) => r.id);
  assert.ok(idsA.includes(a1), "ảnh cam A phải nằm trong list ?cameraId=camA");
  assert.ok(!idsA.includes(a2) && !idsA.includes(a3), "list ?cameraId=camA không chứa ảnh cam B hay ảnh rời");

  const all = await call("/api/assets", "GET", undefined, owner());
  const idsAll = (all.data as any[]).map((r) => r.id);
  for (const id of [a1, a2, a3]) assert.ok(idsAll.includes(id), `list chung phải có asset ${id}`);

  const byViewer = await call(`/api/assets?cameraId=${camA}`, "GET", undefined, viewer());
  assert.ok((byViewer.data as any[]).some((r) => r.id === a1), "viewer đọc được ảnh gắn camera");

  const byT2 = await call("/api/assets", "GET", undefined, t2owner());
  assert.ok(!(byT2.data as any[]).some((r) => r.id === a1), "tenant 2 không thấy asset tenant 1");

  assert.equal((await call("/api/assets", "GET", undefined, "")).status, 401);
  assert.equal((await call(`/api/assets?cameraId=abc`, "GET", undefined, owner())).status, 400);
});

/* ================= 2. Negative: camera tenant khác / không tồn tại / quyền ================= */

test("cameraId tenant khác hoặc không tồn tại ⇒ 404; thiếu quyền ⇒ 403; không phiên ⇒ 401", async () => {
  const img = await jpeg(4);
  for (const camId of [camC, 99999999]) {
    const r = await postAsset({ dataUrl: img, cameraId: camId });
    assert.equal(r.status, 404, `cameraId=${camId} phải 404 — ${JSON.stringify(r.data)}`);
  }
  assert.equal((await postAsset({ dataUrl: img, cameraId: "abc" })).status, 400, "cameraId không phải số ⇒ 400");
  assert.equal((await call("/api/assets", "POST", { dataUrl: img }, viewer())).status, 403);
  assert.equal((await call("/api/assets", "POST", { dataUrl: img }, "")).status, 401);

  const t2 = await postAsset({ dataUrl: await jpeg(5), origin: "capture", cameraId: camC }, t2owner());
  assert.equal(t2.status, 201, "owner tenant 2 gắn camera của chính mình phải được");
  aT2 = t2.data.id;
  const [row] = await db.select({ cameraId: assets.cameraId, tenantId: assets.tenantId }).from(assets).where(eq(assets.id, aT2));
  assert.equal(row.cameraId, camC);
  assert.equal(row.tenantId, t2id);
});

/* ================= 3. Enqueue idempotent: asset:<id> ================= */

test("hai lần enqueue cùng asset ⇒ đúng 1 job asset.index", async () => {
  const job = await indexJobOf(a1);
  assert.equal(job.state, "queued");
  const again = await enqueueJob("asset.index", { assetId: a1, demoMode: false, allowRemote: false, asOf: new Date().toISOString() }, ownerSession, `asset:${a1}`);
  assert.equal(again.duplicate, true);
  assert.equal(again.job.id, job.id);
  await indexJobOf(a1); // vẫn đúng 1 hàng
  const dup = await postAsset({ dataUrl: await jpeg(1), origin: "capture", cameraId: camA }); // re-upload cùng ảnh
  assert.equal(dup.status, 200);
  assert.equal(dup.data.id, a1, "dedup trả asset cũ");
  await indexJobOf(a1); // vẫn đúng 1 job sau re-upload
});

/* ================= 4. Worker: thành công ghi extraction; AI lỗi không mất asset ================= */

test("index thành công ⇒ extraction taskType=index; AI lỗi ⇒ job failed + error_code, attempts ≤ 3, asset còn", { timeout: 60000 }, async () => {
  state.calls = 0;
  await clearBreaker();
  const job = await indexJobOf(a1);
  await runJob(job.id);
  const [j1] = await db.select().from(aiJobs).where(eq(aiJobs.id, job.id));
  assert.equal(j1.state, "succeeded", JSON.stringify({ code: j1.errorCode, error: j1.error }));
  assert.equal(j1.attempts, 1);
  assert.ok(j1.result?.extractionId, "job phải trả extractionId");
  const [ex] = await db.select().from(extractions).where(eq(extractions.id, j1.result!.extractionId!));
  assert.equal(ex.assetId, a1);
  assert.equal(ex.taskType, "index");
  assert.equal(ex.status, "REVIEW_REQUIRED");
  assert.ok(ex.result?.ocrText.includes(uniq) || ex.result?.structured.some((s) => s.value.includes(uniq)), "kết quả index chứa nội dung ảnh");
  assert.ok(state.calls >= 1, "worker phải gọi adapter đã cấu hình");

  state.down = true;
  const jobB = await indexJobOf(a2);
  let jb = jobB;
  for (let i = 0; i < 12 && jb.state !== "failed"; i++) {
    await clearBreaker();
    await runJob(jobB.id);
    [jb] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobB.id));
    if (jb.state !== "failed") await wait(1400);
  }
  state.down = false;
  await clearBreaker();
  assert.equal(jb.state, "failed", `job phải failed sau retry — ${logs.slice(-800)}`);
  assert.ok(jb.errorCode, "job failed phải có error_code");
  assert.ok(jb.attempts >= 1 && jb.attempts <= 3, `attempts=${jb.attempts} phải trong [1,3]`);
  const [assetRow] = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, a2));
  assert.ok(assetRow, "AI lỗi không được làm mất asset");
});

/* ================= 5. Consent: egress remote + chưa cho phép ⇒ CONSENT_REQUIRED, 0 fetch ================= */

test("remoteProcessingAllowed=false + egress remote ⇒ job failed CONSENT_REQUIRED, không fetch ra ngoài", async () => {
  process.env.DAI_OCR_EGRESS = "remote";
  try {
    await clearBreaker();
    const jobC = await indexJobOf(a3);
    let calls = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { calls++; return realFetch(...args); }) as typeof fetch;
    try {
      await runJob(jobC.id);
    } finally {
      globalThis.fetch = realFetch;
    }
    const [jc] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobC.id));
    assert.equal(jc.state, "failed");
    assert.equal(jc.errorCode, "CONSENT_REQUIRED");
    assert.ok(jc.attempts >= 1 && jc.attempts <= 3);
    assert.equal(calls, 0, "chưa consent thì không được phát request ra ngoài");
  } finally {
    process.env.DAI_OCR_EGRESS = "local";
    globalThis.fetch = realFetch;
  }
});

/* ================= 6. Search trong scope ================= */

test("search theo note item và text extraction, đúng tenant/camera scope; viewer đọc được", async () => {
  const item = await call("/api/knowledge/items", "POST", { scope: "camera", cameraId: camA, title: `${prefix} mục`, sku: "SKU-T7", note: `ghi chú ${uniq}-item` }, owner());
  assert.equal(item.status, 201, JSON.stringify(item.data));
  itemIds.push(item.data.id);
  const item2 = await call("/api/knowledge/items", "POST", { scope: "workspace", title: `${prefix} t2 mục`, note: `ghi chú ${uniq}-t2` }, t2owner());
  assert.equal(item2.status, 201, JSON.stringify(item2.data));
  itemIds.push(item2.data.id);

  const q = encodeURIComponent(uniq);
  const s1 = await call(`/api/knowledge/search?q=${q}`, "GET", undefined, owner());
  assert.equal(s1.status, 200, JSON.stringify(s1.data));
  assert.ok(s1.data.items.some((i: any) => i.id === item.data.id && i.cameraId === camA), "tìm thấy item theo note");
  assert.ok(!s1.data.items.some((i: any) => i.id === item2.data.id), "owner tenant 1 không thấy item tenant 2");
  const hit = (s1.data.assets as any[]).find((a) => a.assetId === a1);
  assert.ok(hit, "tìm thấy asset qua text extraction");
  assert.equal(hit.cameraId, camA);
  assert.ok(hit.snippet.length > 0 && hit.extractionId > 0);

  const scoped = await call(`/api/knowledge/search?q=${q}&cameraId=${camA}`, "GET", undefined, owner());
  assert.ok((scoped.data.assets as any[]).some((a) => a.assetId === a1));
  const wrongCam = await call(`/api/knowledge/search?q=${q}&cameraId=${camB}`, "GET", undefined, owner());
  assert.ok(!(wrongCam.data.assets as any[]).some((a) => a.assetId === a1), "lọc cameraId=camB loại asset cam A");
  assert.ok(!(wrongCam.data.items as any[]).some((i) => i.id === item.data.id), "lọc cameraId=camB loại item cam A");

  const byViewer = await call(`/api/knowledge/search?q=${q}`, "GET", undefined, viewer());
  assert.equal(byViewer.status, 200);
  assert.ok((byViewer.data.assets as any[]).some((a) => a.assetId === a1), "viewer đọc được kết quả trong scope");
  assert.ok((byViewer.data.items as any[]).some((i) => i.id === item.data.id));

  const jobT2 = await indexJobOf(aT2);
  await runJob(jobT2.id); // index asset tenant 2 — phiên job là của t2owner
  const [jT2] = await db.select().from(aiJobs).where(eq(aiJobs.id, jobT2.id));
  assert.equal(jT2.state, "succeeded", JSON.stringify({ code: jT2.errorCode, error: jT2.error }));

  const byT2 = await call(`/api/knowledge/search?q=${q}`, "GET", undefined, t2owner());
  assert.ok((byT2.data.items as any[]).some((i) => i.id === item2.data.id), "tenant 2 thấy item của mình");
  assert.ok((byT2.data.assets as any[]).some((a) => a.assetId === aT2 && a.cameraId === camC), "tenant 2 thấy asset đã index của mình");
  assert.ok(!(byT2.data.items as any[]).some((i) => i.id === item.data.id), "tenant 2 không thấy item tenant 1");
  assert.ok(!(byT2.data.assets as any[]).some((a) => a.assetId === a1 || a.assetId === a3), "tenant 2 không thấy asset tenant 1");

  const empty = await call("/api/knowledge/search", "GET", undefined, owner());
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data, { items: [], assets: [] });
  assert.equal((await call(`/api/knowledge/search?q=${q}`, "GET", undefined, "")).status, 401);
});
