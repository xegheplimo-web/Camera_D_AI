import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync, randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { db, pool } from "../src/db";
import { users, cameras, events, assets, messages, aiJobs, sessions, extractions, appSettings, auditLog } from "../src/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { enqueueJob } from "../src/lib/ai/jobs";
import { type SessionPayload } from "../src/lib/token";

/**
 * CAM-G1-001 — RBAC matrix + object-scope (IDOR) contract suite.
 * 2 users per role (A/B) x owner/operator/viewer. Asserts:
 *   - unauthenticated -> 401, wrong role -> 403
 *   - user-bound objects (assets, extractions, jobs, messages) never cross users -> 404
 *   - shared camera-bound resources stay reachable through resource control
 *   - role=owner keeps the documented admin override (whole queue/objects readable,
 *     deletes allowed); write scope for operator/viewer is strictly own rows.
 */
const prefix = `scope_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const fixtureNote = `${prefix} secret note ${randomBytes(4).toString("hex")}`;
let app: ChildProcess, base: string;
const cookies: Record<string, string> = {};
const userIds: number[] = [];
let camId: number, privateAssetA: number, sharedAssetA: number, demoAsset: number, extractionA: number, extractionDraftA: number, jobA: string, eventA: number;
let settingsBefore: (typeof appSettings.$inferSelect)[] = [];
let logs = "";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const s = createServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); const n = (s.address() as { port: number }).port; await new Promise<void>((r) => s.close(() => r())); return n; }
async function call(path: string, method = "GET", body?: unknown, cookie = "", headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const raw = await response.text();
  let data: any; try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 300) }; }
  return { status: response.status, data, headers: response.headers };
}
const A = (role: string) => cookies[`a_${role}`];
const B = (role: string) => cookies[`b_${role}`];
async function login(who: string) {
  const r = await call("/api/auth/login", "POST", { login: `${prefix}_${who}`, password });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  cookies[who] = r.headers.get("set-cookie")!.split(";")[0];
}

before(async () => {
  settingsBefore = await db.select().from(appSettings);
  for (const [key, value] of [["demoMode", true], ["remoteProcessingAllowed", false]] as const)
    await db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  const who: [string, string][] = [["a_owner", "owner"], ["b_owner", "owner"], ["a_operator", "operator"], ["b_operator", "operator"], ["a_viewer", "viewer"], ["b_viewer", "viewer"]];
  const inserted = await db.insert(users).values(who.map(([login, role]) => ({ login: `${prefix}_${login}`, displayName: `${prefix}_${login}`, role, passwordHash }))).returning();
  userIds.push(...inserted.map((u) => u.id));
  const ownerA = inserted.find((u) => u.login === `${prefix}_a_owner`)!;

  const [camera] = await db.insert(cameras).values({ code: prefix, name: `${prefix} cam`, location: "Fixture", sourceType: "demo", status: "demo" }).returning();
  camId = camera.id;
  const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#203040" } }).jpeg().toBuffer();
  const sha = createHash("sha256").update(image).digest("hex");
  const data = image.toString("base64");
  const [a1] = await db.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: sha, data, sizeBytes: image.length, origin: "upload", uploadedBy: `${prefix}_a_owner`, userId: ownerA.id }).returning();
  privateAssetA = a1.id;
  const [a2] = await db.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: `${sha}-cam`, data, sizeBytes: image.length, origin: "capture", uploadedBy: `${prefix}_a_owner`, userId: ownerA.id, cameraId: camId }).returning();
  sharedAssetA = a2.id;
  const [a3] = await db.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: `${sha}-demo`, url: "/cams/cam1.jpg", origin: "demo", cameraId: camId }).returning();
  demoAsset = a3.id;
  const [e1] = await db.insert(extractions).values({ assetId: privateAssetA, title: `${prefix} A note`, note: fixtureNote, status: "DRAFT", createdBy: `${prefix}_a_owner`, userId: ownerA.id, source: "live" }).returning();
  extractionA = e1.id;
  const [e2] = await db.insert(extractions).values({ assetId: sharedAssetA, title: `${prefix} A draft`, note: "draft", status: "DRAFT", createdBy: `${prefix}_a_owner`, userId: ownerA.id, source: "live" }).returning();
  extractionDraftA = e2.id;
  const [ev] = await db.insert(events).values({ cameraId: camId, type: "manual", label: `${prefix} shared event`, source: "manual", clientReported: false, createdBy: `${prefix}_a_owner` }).returning();
  eventA = ev.id;
  await db.insert(messages).values({ role: "user", text: `${prefix} private question`, userId: ownerA.id, device: "test" });
  const jobSess: SessionPayload = { sid: "fixture-sid", sub: ownerA.id, name: ownerA.displayName, role: "owner", device: "test", exp: Math.floor(Date.now() / 1000) + 3600 };
  const { job } = await enqueueJob("report", { question: `${prefix} report?`, demoMode: true, allowRemote: false, asOf: new Date().toISOString() }, jobSess, `scope:${randomUUID()}`);
  jobA = job.id;

  const appPort = await freePort(); base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);
  for (const [who2] of who) await login(who2);
}, { timeout: 60000 });

after(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  if (userIds.length) {
    await db.delete(aiJobs).where(inArray(aiJobs.userId, userIds));
    await db.delete(messages).where(inArray(messages.userId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(extractions).where(inArray(extractions.userId, userIds));
    await db.delete(events).where(eq(events.cameraId, camId));
    await db.delete(assets).where(eq(assets.cameraId, camId));
    await db.delete(assets).where(inArray(assets.userId, userIds));
    await db.delete(cameras).where(eq(cameras.id, camId));
    await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await db.delete(appSettings); if (settingsBefore.length) await db.insert(appSettings).values(settingsBefore);
  await pool.end();
}, { timeout: 20000 });

// ---------- 1. Authentication gate (proxy + route) ----------

test("unauthenticated GET requests fail closed (401)", async () => {
  for (const path of [`/api/assets/${privateAssetA}`, "/api/events", "/api/dashboard", "/api/stats", "/api/extractions", "/api/report?days=1", `/api/cameras/${camId}/stream`, "/api/jobs", "/api/alerts", "/api/settings", "/api/orchestration", "/api/chat"])
    assert.equal((await call(path)).status, 401, path);
});

test("unauthenticated POST/PATCH requests fail closed (401)", async () => {
  assert.equal((await call("/api/chat", "POST", { question: "x" })).status, 401);
  assert.equal((await call(`/api/events/${eventA}`, "PATCH", { note: "x" })).status, 401);
  assert.equal((await call("/api/assets", "POST", { dataUrl: "data:image/jpeg;base64,/9j/" })).status, 401);
});

// ---------- 2. Role gates (401 -> 403 hierarchy) ----------

test("viewer cannot create or upload (capture gate)", async () => {
  const v = A("viewer");
  assert.equal((await call("/api/assets", "POST", { dataUrl: "data:image/jpeg;base64,/9j/" }, v)).status, 403);
  assert.equal((await call("/api/events", "POST", { cameraId: camId, type: "manual", label: "x" }, v)).status, 403);
  assert.equal((await call("/api/extractions", "POST", { assetId: sharedAssetA, note: "x" }, v)).status, 403);
  assert.equal((await call("/api/vision/frame", "POST", { image: "data:image/jpeg;base64,/9j/x" }, v)).status, 403);
});

test("viewer cannot annotate, verify, delete, or export", async () => {
  const v = A("viewer");
  assert.equal((await call(`/api/events/${eventA}`, "PATCH", { note: "x" }, v)).status, 403);
  assert.equal((await call(`/api/events/${eventA}?confirm=yes`, "DELETE", undefined, v)).status, 403);
  assert.equal((await call(`/api/extractions/${extractionDraftA}`, "PATCH", { action: "verify" }, v)).status, 403);
  assert.equal((await call(`/api/extractions/${extractionDraftA}?confirm=yes`, "DELETE", undefined, v)).status, 403);
  assert.equal((await call("/api/report", "GET", undefined, v)).status, 403);
});

test("viewer cannot manage cameras, alerts, settings, admin, orchestration", async () => {
  const v = A("viewer");
  assert.equal((await call("/api/cameras", "POST", { name: "x", location: "y" }, v)).status, 403);
  assert.equal((await call("/api/cameras/discover", "POST", {}, v)).status, 403);
  assert.equal((await call(`/api/cameras/${camId}/connect`, "POST", {}, v)).status, 403);
  assert.equal((await call("/api/alerts", "PUT", { action: "create", name: "x" }, v)).status, 403);
  assert.equal((await call("/api/admin", "GET", undefined, v)).status, 403);
  assert.equal((await call("/api/settings", "PATCH", { demoMode: true }, v)).status, 403);
  assert.equal((await call("/api/orchestration", "POST", { action: "probe", service: "hermes" }, v)).status, 403);
});

test("operator cannot use owner-only actions (admin reset, delete, remote toggle)", async () => {
  const o = A("operator");
  assert.equal((await call("/api/admin", "POST", { action: "reset_all", confirmPhrase: "XOA DU LIEU" }, o)).status, 403);
  assert.equal((await call(`/api/events/${eventA}?confirm=yes`, "DELETE", undefined, o)).status, 403);
  assert.equal((await call(`/api/extractions/${extractionDraftA}?confirm=yes`, "DELETE", undefined, o)).status, 403);
  assert.equal((await call("/api/settings", "PATCH", { remoteProcessingAllowed: true }, o)).status, 403);
});

test("orchestration API is owner-only platform surface (T-1301)", async () => {
  assert.equal((await call("/api/orchestration", "GET", undefined, A("viewer"))).status, 403);
  assert.equal((await call("/api/orchestration", "GET", undefined, A("operator"))).status, 403);
  assert.equal((await call("/api/orchestration", "POST", { action: "probe", service: "hermes" }, A("operator"))).status, 403);
  const owner = await call("/api/orchestration", "GET", undefined, A("owner"));
  assert.equal(owner.status, 200);
  assert.ok(Array.isArray(owner.data.services), "owner still receives services[] for the admin console");
});

test("operator keeps operator rights (export report, annotate shared event)", async () => {
  const o = A("operator");
  assert.equal((await call("/api/report", "GET", undefined, o)).status, 200);
  assert.equal((await call(`/api/events/${eventA}`, "PATCH", { note: "operator annotation" }, o)).status, 200);
});

// ---------- 3. Object scope: assets ----------

test("cross-user asset read is blocked (404) for viewer and operator", async () => {
  assert.equal((await call(`/api/assets/${privateAssetA}`, "GET", undefined, B("viewer"))).status, 404);
  assert.equal((await call(`/api/assets/${privateAssetA}`, "GET", undefined, B("operator"))).status, 404);
  assert.equal((await call(`/api/assets/${privateAssetA}`, "GET", undefined, A("owner"))).status, 200);
});

test("same-role cross-user asset read stays blocked", async () => {
  const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#405060" } }).jpeg().toBuffer();
  const up = await call("/api/assets", "POST", { dataUrl: `data:image/jpeg;base64,${image.toString("base64")}`, origin: "upload" }, B("operator"));
  assert.equal(up.status, 201);
  assert.equal((await call(`/api/assets/${up.data.id}`, "GET", undefined, B("operator"))).status, 200); // own
  assert.equal((await call(`/api/assets/${up.data.id}`, "GET", undefined, A("viewer"))).status, 404); // other user
  assert.equal((await call(`/api/assets/${up.data.id}`, "GET", undefined, A("operator"))).status, 404); // other user, same role
});

test("camera-bound evidence is shared across users", async () => {
  assert.equal((await call(`/api/assets/${sharedAssetA}`, "GET", undefined, B("viewer"))).status, 200);
  assert.equal((await call(`/api/assets/${sharedAssetA}`, "GET", undefined, B("operator"))).status, 200);
});

test("demo media is shared across users", async () => {
  const demo = await call(`/api/assets/${demoAsset}`, "GET", undefined, B("viewer"));
  assert.ok([200, 302].includes(demo.status), String(demo.status));
});

test("owner admin override can read any user asset", async () => {
  assert.equal((await call(`/api/assets/${privateAssetA}`, "GET", undefined, B("owner"))).status, 200);
});

test("invalid asset ids fail closed (400/404)", async () => {
  const v = A("viewer");
  assert.equal((await call("/api/assets/0", "GET", undefined, v)).status, 400);
  assert.equal((await call("/api/assets/-5", "GET", undefined, v)).status, 400);
  assert.equal((await call("/api/assets/abc", "GET", undefined, v)).status, 400);
  assert.equal((await call("/api/assets/999999", "GET", undefined, v)).status, 404);
});

test("dedup never leaks another user's asset id", async () => {
  const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#203040" } }).jpeg().toBuffer();
  const up = await call("/api/assets", "POST", { dataUrl: `data:image/jpeg;base64,${image.toString("base64")}`, origin: "upload" }, B("operator"));
  assert.equal(up.status, 201);
  assert.notEqual(up.data.id, privateAssetA);
});

// ---------- 4. Object scope: extractions ----------

test("extraction list never leaks other users' rows", async () => {
  const listB = await call("/api/extractions", "GET", undefined, B("viewer"));
  assert.equal(listB.status, 200);
  assert.ok(!listB.data.some((r: any) => r.id === extractionA || r.id === extractionDraftA), "B must not see A's extractions");
  const listA = await call("/api/extractions", "GET", undefined, A("owner"));
  assert.ok(listA.data.some((r: any) => r.id === extractionA));
});

test("cross-user extraction write is blocked for operator/viewer", async () => {
  assert.equal((await call(`/api/extractions/${extractionA}`, "PATCH", { title: "stolen" }, B("operator"))).status, 404);
  assert.equal((await call(`/api/extractions/${extractionA}`, "PATCH", { title: "stolen" }, B("viewer"))).status, 403); // role gate fires first
});

test("owner admin override can delete user data (cleanup)", async () => {
  assert.equal((await call(`/api/extractions/${extractionDraftA}?confirm=yes`, "DELETE", undefined, B("owner"))).status, 200);
  const listA = await call("/api/extractions", "GET", undefined, A("owner"));
  assert.ok(!listA.data.some((r: any) => r.id === extractionDraftA));
});

// ---------- 5. Object scope: jobs ----------

test("cross-user job read/cancel/retry is blocked (404)", async () => {
  assert.equal((await call(`/api/jobs/${jobA}`, "GET", undefined, B("viewer"))).status, 404);
  assert.equal((await call(`/api/jobs/${jobA}`, "GET", undefined, B("operator"))).status, 404);
  assert.equal((await call(`/api/jobs/${jobA}`, "PATCH", { action: "cancel" }, B("operator"))).status, 404);
  assert.equal((await call(`/api/jobs/${jobA}`, "PATCH", { action: "retry" }, B("operator"))).status, 404);
});

test("owner sees whole queue; non-owner scope=all stays mine", async () => {
  assert.equal((await call(`/api/jobs/${jobA}`, "GET", undefined, B("owner"))).status, 200);
  const mine = await call("/api/jobs?scope=all", "GET", undefined, B("operator"));
  assert.equal(mine.data.scope, "mine");
  assert.ok(!mine.data.items.some((j: any) => j.id === jobA));
  const all = await call("/api/jobs?scope=all", "GET", undefined, B("owner"));
  assert.equal(all.data.scope, "all");
  assert.ok(all.data.items.some((j: any) => j.id === jobA));
});

// ---------- 6. Object scope: chat / messages / SQL answers ----------

test("chat history is per-user", async () => {
  const histB = await call("/api/chat", "GET", undefined, B("viewer"));
  assert.equal(histB.status, 200);
  assert.ok(!histB.data.some((m: any) => m.text?.includes(prefix)), "B must not see A's messages");
});

test("SQL answer counts stay inside caller scope (no cross-user data)", async () => {
  const q = "Có bao nhiêu ảnh và ghi chú đã lưu?";
  const ansB = await call("/api/chat", "POST", { question: q, requestId: randomUUID() }, B("viewer"));
  const ansA = await call("/api/chat", "POST", { question: q, requestId: randomUUID() }, A("owner"));
  assert.equal(ansB.status, 200); assert.equal(ansA.status, 200);
  assert.ok(ansA.data.assistant.answer.value >= 2, "A counts own uploads incl. private asset");
  assert.ok(ansB.data.assistant.answer.value < ansA.data.assistant.answer.value, "B must not count A's private asset");
});

test("chat search never surfaces another user's private note", async () => {
  const find = await call("/api/chat", "POST", { question: `tìm ${fixtureNote.split(" ").slice(0, 2).join(" ")}`, requestId: randomUUID() }, B("viewer"));
  assert.equal(find.status, 200);
  assert.ok(!JSON.stringify(find.data.assistant.answer).includes(fixtureNote), "B must not see A's private note text");
});

// ---------- 7. Object scope: events / cameras ----------

test("events are camera-shared telemetry; any role can read, operator can annotate", async () => {
  assert.equal((await call(`/api/events/${eventA}`, "PATCH", { note: "B edits shared event" }, B("operator"))).status, 200);
  const list = await call("/api/events", "GET", undefined, B("viewer"));
  assert.equal(list.status, 200);
  assert.ok(list.data.items.some((e: any) => e.id === eventA));
});

test("event asset attachment is scope-checked (cannot attach foreign private asset)", async () => {
  const bad = await call("/api/events", "POST", { cameraId: camId, type: "manual", label: "leak", assetId: privateAssetA }, B("operator"));
  assert.equal(bad.status, 404);
  const ok = await call("/api/events", "POST", { cameraId: camId, type: "manual", label: "shared ok", assetId: sharedAssetA }, B("operator"));
  assert.equal(ok.status, 201);
  assert.equal((await call("/api/events", "POST", { cameraId: 999999, type: "manual", label: "x" }, B("operator"))).status, 400);
});

test("camera resource control: exists-check + fail-closed stream", async () => {
  assert.equal((await call(`/api/cameras/${camId}/stream`, "GET", undefined, B("viewer"))).status, 404); // demo cam has no live stream
  assert.equal((await call(`/api/cameras/999999/stream`, "GET", undefined, B("viewer"))).status, 404);
  const cams = await call("/api/cameras", "GET", undefined, B("viewer"));
  assert.ok(cams.data.some((c: any) => c.id === camId));
  const disc = await call("/api/cameras/discover", "POST", {}, B("operator"));
  assert.ok(![401, 403].includes(disc.status), `operator discover must not be denied (got ${disc.status})`);
});
