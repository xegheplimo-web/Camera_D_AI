import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, exec, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { ensureDefaultTenant } from "./helpers/tenant";
import { db, pool } from "../src/db";
import { users, cameras, events, sessions, messages, aiJobs, auditLog } from "../src/db/schema";
import { eq, inArray, like } from "drizzle-orm";

const execAsync = promisify(exec);

/**
 * CAM-G2-001 — Deterministic RTSP fixture + stream lifecycle (không false-PASS).
 *
 * Fixture: `docker compose -f docker-compose.test.yml -p camg2 up -d --wait`
 *   ffmpeg testsrc2 (+ bit-sequence geq overlay, H.264 baseline) --RTSP--> mediamtx
 *   (192.168.99.10:8554/g2cam, exporter :9998) --> go2rtc (127.0.0.1:1984 loopback)
 *   --> Next /api/cameras/[id]/stream (MJPEG multipart).
 *
 * Chạy: node --import tsx --test tests/rtsp-fixture.test.ts
 *   G2_SKIP_BUILD=1  bỏ qua `npm run build` trong before() (chỉ cho vòng dev)
 *   G2_STREAM_SECONDS=620  soak dài (mặc định 65 = vượt ngưỡng 60s của spec)
 * Yêu cầu: Docker daemon + Postgres (DATABASE_URL) + CAMERA_CREDENTIAL_KEY.
 */
const COMPOSE_FILE = "docker-compose.test.yml";
const PROJECT = "camg2";
const RTSP_URL = "rtsp://192.168.99.10:8554/g2cam";
const GO2RTC = "http://127.0.0.1:1984";
const MTX_API = "http://127.0.0.1:9997";
const MTX_METRICS = "http://127.0.0.1:9998/metrics";
const STREAM_SECONDS = Math.max(61, Number(process.env.G2_STREAM_SECONDS) || 65);
const APP_IDLE_MS = 8_000; // idle watchdog app-side; phải > reconnect latency của go2rtc (~5s)
const FRAME_CENTERS = [20, 52, 84, 116, 148].map((x) => ({ x, y: 20 }));

const prefix = `g2_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: ChildProcess, base: string, ownerCookie = "", viewerCookie = "";
let camId = 0, streamName = "", camIds: number[] = [], userIds: number[] = [];
let composeOwnedByUs = false;
let logs = "";
const metricSamples: { t: string; text: string }[] = [];
const reconnectSamples: number[] = [];
const disconnectCleanups: number[] = [];
const report: string[] = [];

function compose(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", ["compose", "-f", COMPOSE_FILE, "-p", PROJECT, ...args], { timeout: 120_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(`docker compose ${args.join(" ")}: ${stderr || err.message}`)) : resolve(stdout));
  });
}

async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const n = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return n;
}

async function call(path: string, method = "GET", body?: unknown, cookie = ownerCookie, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const raw = await response.text();
  let data: any;
  try { data = JSON.parse(raw); } catch { data = { raw: raw.slice(0, 300) }; }
  return { status: response.status, data, headers: response.headers };
}

async function login(role: string) {
  const r = await call("/api/auth/login", "POST", { login: `${prefix}_${role}`, password }, "");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.headers.get("set-cookie")!.split(";")[0];
}

async function pollUntil(fn: () => Promise<boolean>, timeoutMs: number, interval = 500, label = ""): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return;
    await wait(interval);
  }
  throw new Error(`pollUntil timeout ${timeoutMs}ms: ${label}`);
}

async function mtxPathReady(): Promise<boolean> {
  try {
    const r = await fetch(`${MTX_API}/v3/paths/get/g2cam`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const j = await r.json();
    return j.ready === true && j.source != null;
  } catch { return false; }
}

async function go2rtcStream(name: string): Promise<{ producers: { url: string }[]; consumers: any[] | null }> {
  const r = await fetch(`${GO2RTC}/api/streams`, { signal: AbortSignal.timeout(4000) });
  const j = await r.json();
  return j[name] ?? { producers: [], consumers: null };
}

async function mjpegConsumers(name: string): Promise<number> {
  const s = await go2rtcStream(name);
  return (s.consumers ?? []).filter((c) => c.format_name === "mjpeg").length;
}

async function scrapeMetrics(): Promise<string> {
  const r = await fetch(MTX_METRICS, { signal: AbortSignal.timeout(4000) });
  const text = await r.text();
  metricSamples.push({ t: new Date().toISOString(), text });
  return text;
}

function metricValue(text: string, name: string): number {
  const m = new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+(\\d+(?:\\.\\d+)?)`, "m").exec(text);
  return m ? Number(m[1]) : NaN;
}

/** Parse multipart/x-mixed-replace (--frame boundary, Content-Length per part). */
function mjpegSplitter(onFrame: (jpeg: Buffer) => void) {
  let buf = Buffer.alloc(0);
  const soi = Buffer.from([0xff, 0xd8]);
  return (chunk: Uint8Array) => {
    buf = Buffer.concat([buf, Buffer.from(chunk)]);
    for (;;) {
      const b = buf.indexOf("--frame");
      if (b < 0) { if (buf.length > 1 << 20) buf = buf.subarray(-16); return; }
      const hEnd = buf.indexOf("\r\n\r\n", b);
      if (hEnd < 0) { buf = buf.subarray(b); return; }
      const header = buf.slice(b, hEnd).toString("latin1");
      const m = /content-length:\s*(\d+)/i.exec(header);
      let end = -1;
      if (m) end = hEnd + 4 + Number(m[1]);
      else {
        const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), hEnd);
        if (eoi >= 0) end = eoi + 2;
      }
      if (end < 0 || buf.length < end) { buf = buf.subarray(b); return; }
      const jpeg = buf.slice(hEnd + 4, end);
      if (jpeg.indexOf(soi) === 0) onFrame(jpeg);
      buf = buf.subarray(end);
    }
  };
}

/** Đọc frame sequence number (5 ô bit burn-in, N mod 32) sau khi JPEG decode. */
async function frameSeq(jpeg: Buffer): Promise<{ seq: number; w: number; h: number }> {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const lum = (x: number, y: number) => {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += data[((y + dy) * info.width + x + dx) * info.channels];
    return sum / 9;
  };
  let seq = 0;
  FRAME_CENTERS.forEach(({ x, y }, i) => { if (lum(x, y) > 127) seq |= 1 << i; });
  return { seq, w: info.width, h: info.height };
}

type FrameStats = { frames: number; seqs: number[]; arrivals: number[]; bytes: number; error?: string; done: boolean };

/** Mở MJPEG stream của camera qua app, decode từng JPEG bằng sharp, đo sequence + cadence. */
async function collectStream(id: number, seconds: number, cookie: string): Promise<FrameStats> {
  const res = await fetch(`${base}/api/cameras/${id}/stream`, { headers: { Cookie: cookie } });
  const stats: FrameStats = { frames: 0, seqs: [], arrivals: [], bytes: 0, done: false };
  if (res.status !== 200 || !res.body) { stats.error = `status ${res.status}`; return stats; }
  const pending: Promise<number>[] = [];
  const feed = mjpegSplitter((jpeg) => {
    stats.frames++;
    stats.arrivals.push(Date.now());
    stats.bytes += jpeg.length;
    pending.push(frameSeq(jpeg).then(({ seq }) => { stats.seqs.push(seq); return seq; }).catch(() => { stats.seqs.push(-1); return -1; }));
  });
  const reader = res.body.getReader();
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < seconds * 1000) {
      const { done, value } = await reader.read();
      if (done) { stats.done = true; break; }
      feed(value);
    }
  } catch (e) {
    stats.error = e instanceof Error ? e.message : String(e);
  }
  await reader.cancel().catch(() => {});
  await Promise.all(pending); // decode seq của frame cuối cũng phải xong trước khi chấm
  return stats;
}

async function seqCheck(seqs: number[]): Promise<{ ordered: boolean; drops: number }> {
  let drops = 0;
  for (let i = 1; i < seqs.length; i++) {
    const d = (seqs[i] - seqs[i - 1] + 32) % 32;
    if (d === 0) return { ordered: false, drops };
    drops += d - 1;
  }
  return { ordered: true, drops };
}

before(async () => {
  // 1. Build tươi — test phải chạy code hiện tại, không chấp nhận .next cũ.
  if (process.env.G2_SKIP_BUILD !== "1") {
    await execAsync("npm run build", { timeout: 300_000, windowsHide: true });
    report.push("PASS: npm run build trong before() hoàn tất");
  }
  // 2. Fixture lên (tự down -v trong after); stack đang chạy sẵn được tái dùng.
  await compose(["up", "-d", "--wait"]);
  composeOwnedByUs = true;
  await pollUntil(mtxPathReady, 60_000, 1_000, "mediamtx path g2cam ready + publisher");
  await pollUntil(async () => { try { return (await fetch(`${GO2RTC}/api`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }, 30_000, 500, "go2rtc api");
  // 3. DB fixtures + app spawn (giống harness ai-integration/scope-rbac).
  await ensureDefaultTenant(); // POST /api/cameras ghi camera_settings tenant_id=1 (FK)
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  const inserted = await db.insert(users).values(["owner", "viewer"].map((role) => ({ login: `${prefix}_${role}`, displayName: `${prefix}_${role}`, role, passwordHash }))).returning();
  userIds = inserted.map((u) => u.id);
  const appPort = await freePort();
  base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], {
    env: { ...process.env, NODE_ENV: "production", GO2RTC_HOST: "127.0.0.1", GO2RTC_STREAM_IDLE_MS: String(APP_IDLE_MS), GO2RTC_STREAM_CONNECT_MS: "8000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-12000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-12000); });
  await pollUntil(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, 60_000, 250, "next start");
  ownerCookie = await login("owner");
  viewerCookie = await login("viewer");
  // 4. Đăng ký camera qua API bình thường — go2rtc phải chấp nhận stream đúng policy.
  const created = await call("/api/cameras", "POST", { name: `${prefix} fixture`, location: "camnet 192.168.99.0/24", sourceType: "rtsp", rtspUrl: RTSP_URL });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.connected, true, "go2rtc phải chấp nhận stream RTSP fixture hợp lệ");
  camId = created.data.id;
  camIds.push(camId);
  assert.ok(camId > 0);
}, { timeout: 420_000 });

after(async () => {
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await Promise.race([new Promise((r) => app.once("exit", r)), wait(6000)]);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  if (camIds.length) {
    await db.delete(events).where(inArray(events.cameraId, camIds));
    await db.delete(cameras).where(inArray(cameras.id, camIds));
  }
  if (userIds.length) {
    await db.delete(aiJobs).where(inArray(aiJobs.userId, userIds));
    await db.delete(messages).where(inArray(messages.userId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  if (composeOwnedByUs) {
    try { await scrapeMetrics(); } catch { /* exporter có thể đã tắt */ }
    try {
      await mkdir("artifacts/g2", { recursive: true });
      const p95 = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(0.95 * xs.length) - 1)] : null);
      await writeFile("artifacts/g2/metrics-summary.json", JSON.stringify({
        generatedAt: new Date().toISOString(), streamSeconds: STREAM_SECONDS,
        reconnectMs: reconnectSamples, reconnectP95Ms: p95(reconnectSamples),
        disconnectCleanupMs: disconnectCleanups,
        note: "decoded FPS/sequence/drops nằm trong output từng subtest; series đầy đủ ở metrics-timeseries.json",
      }, null, 2));
      await writeFile("artifacts/g2/metrics-timeseries.json", JSON.stringify(metricSamples, null, 2));
    } catch { /* artifact write không được phép fail suite */ }
    await compose(["down", "-v"]).catch(() => {});
  }
  report.forEach((l) => console.log(l));
  await pool.end();
}, { timeout: 60_000 });

test("CAM-G2-001 deterministic RTSP fixture + lifecycle", { timeout: 900_000 }, async (t) => {
  const streamUrl = `/api/cameras/${camId}/stream`;

  await t.test("camera đăng ký đúng policy qua API thường; SSRF negative bị chặn", async () => {
    const list = await call("/api/cameras");
    assert.equal(list.status, 200);
    const cam = list.data.find((c: any) => c.id === camId);
    assert.ok(cam, "camera fixture phải xuất hiện trong danh sách");
    assert.equal(cam.streamName, `dai_cam_${camId}`);
    streamName = cam.streamName;
    assert.equal(cam.status, "degraded", "đăng ký xong → degraded (chưa xác minh online bằng frame)");
    assert.equal(cam.sourceHost, "192.168.99.10:8554");
    assert.ok(!("sourceCiphertext" in cam), "không lộ ciphertext ra API");
    const reg = await go2rtcStream(streamName);
    const urls = reg.producers.map((p) => p.url);
    assert.ok(urls.some((u) => u === RTSP_URL), `go2rtc phải có producer RTSP, got ${urls}`);
    assert.ok(urls.some((u) => u.startsWith("ffmpeg:")), `go2rtc phải có producer ffmpeg transcode, got ${urls}`);
    report.push(`PASS: camera #${camId} đăng ký đúng policy (rtsp+ffmpeg producers, ciphertext không rò)`);
    for (const bad of [
      "rtsp://8.8.8.8/live", "rtsp://127.0.0.1/live", "rtsp://[fe80::1]/live",
      "rtsp://[::1]/live", "rtsp://camera.lan/live", "http://192.168.99.10/live",
      "rtsp://169.254.169.254/live",
    ]) {
      const r = await call("/api/cameras", "POST", { name: `${prefix} ssrf`, location: "x", sourceType: "rtsp", rtspUrl: bad });
      assert.equal(r.status, 400, `${bad} phải bị chặn ở API, got ${r.status}`);
      assert.ok(!r.data.id, "không được tạo camera khi URL bị chặn");
    }
    report.push("PASS: 7 SSRF negatives bị API chặn 400 (outside-CIDR, loopback, v6 link-local, ::1, hostname LAN, http, v4 link-local metadata)");
  });

  await t.test("nhận đúng N=30 frames theo frame sequence burn-in (không byte-hash)", async () => {
    const res = await fetch(base + streamUrl, { headers: { Cookie: ownerCookie } });
    assert.equal(res.status, 200, "stream phải mở 200");
    assert.match(res.headers.get("content-type") ?? "", /^multipart\/x-mixed-replace/i, "MIME phải là MJPEG multipart");
    assert.equal(res.headers.get("content-length"), null, "phải stream chunked, không content-length cố định");
    const frames: Buffer[] = [];
    const feed = mjpegSplitter((jpeg) => frames.push(jpeg));
    const reader = res.body!.getReader();
    const t0 = Date.now();
    while (frames.length < 30 && Date.now() - t0 < 45_000) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(value);
    }
    assert.equal(frames.length, 30, `phải nhận đúng 30 JPEG frames, got ${frames.length}`);
    const seqs: number[] = [];
    for (const f of frames) {
      const { seq, w, h } = await frameSeq(f);
      assert.equal(w, 640); assert.equal(h, 360);
      assert.ok(seq >= 0 && seq < 32, `frame phải decode được seq burn-in, got ${seq}`);
      seqs.push(seq);
    }
    const { ordered, drops } = await seqCheck(seqs);
    assert.ok(ordered, `sequence phải tăng dần mod-32, không lặp/lộn: ${seqs.join(",")}`);
    assert.equal(drops, 0, `không được mất frame trong cửa sổ 30 (drops=${drops}, seqs=${seqs.join(",")})`);
    assert.notDeepEqual(frames[1], frames[5], "hai frame khác sequence phải khác nội dung (không đóng băng)");
    report.push(`PASS: 30/30 frames decode 640x360, seq ${seqs[0]}..${seqs[29]} tăng đúng +1 mod32, 0 drops`);
    await reader.cancel();
    await pollUntil(async () => (await mjpegConsumers(streamName)) === 0, 8_000, 250, "mjpeg consumer count về 0 sau cancel");
  });

  await t.test(`MJPEG stream chạy > ${STREAM_SECONDS}s liên tục, không auto-cắt`, async () => {
    const m0 = await scrapeMetrics();
    const bytes0 = metricValue(m0, "paths_bytes_received");
    const scraper = setInterval(() => { scrapeMetrics().catch(() => {}); }, 5_000);
    const stats = await collectStream(camId, STREAM_SECONDS, viewerCookie);
    clearInterval(scraper);
    assert.equal(stats.done, false, `stream bị cắt sớm (done) sau ${stats.arrivals.length} frames — lỗi lifecycle`);
    assert.equal(stats.error, undefined, `stream lỗi sớm: ${stats.error}`);
    assert.ok(stats.frames > 0, "phải decode được ít nhất 1 frame trong soak");
    assert.ok(stats.seqs.every((s) => s >= 0), "mọi frame JPEG phải decode được seq burn-in");
    const elapsed = (stats.arrivals.at(-1)! - stats.arrivals[0]) / 1000;
    assert.ok(elapsed >= STREAM_SECONDS - 2, `dữ liệu phải chảy liên tục ≥ ${STREAM_SECONDS - 2}s, got ${elapsed.toFixed(1)}s`);
    const { ordered, drops } = await seqCheck(stats.seqs.filter((s) => s >= 0));
    assert.ok(ordered, "sequence phải monotonic suốt soak");
    const fps = stats.frames / elapsed;
    const gaps = stats.arrivals.slice(1).map((a, i) => a - stats.arrivals[i]);
    const p95 = gaps.sort((a, b) => a - b)[Math.floor(0.95 * gaps.length)];
    const m1 = await scrapeMetrics();
    const bytes1 = metricValue(m1, "paths_bytes_received");
    assert.ok(bytes1 > bytes0, `mediamtx bytes_received phải tăng trong soak (${bytes0} → ${bytes1})`);
    assert.ok(fps > 1.5, `decoded FPS phải dương đáng kể, got ${fps.toFixed(2)}`);
    report.push(`PASS: soak ${elapsed.toFixed(0)}s — ${stats.frames} frames, decoded ${fps.toFixed(1)} fps, gap p95 ${p95}ms, seq drops ${drops}, mtx bytes ${bytes0}→${bytes1}`);
  });

  await t.test("client disconnect → upstream cancel sạch, không consumer mồ côi", async () => {
    const res = await fetch(base + streamUrl, { headers: { Cookie: ownerCookie } });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const feed = mjpegSplitter(() => {});
    for (let i = 0; i < 3; i++) { const { value } = await reader.read(); feed(value!); }
    assert.ok((await mjpegConsumers(streamName)) >= 1, "phải có ít nhất 1 mjpeg consumer đang mở");
    const t0 = Date.now();
    await reader.cancel();
    await pollUntil(async () => (await mjpegConsumers(streamName)) === 0, 8_000, 250, "consumer count về 0");
    disconnectCleanups.push(Date.now() - t0);
    report.push(`PASS: disconnect → go2rtc mjpeg consumer về 0 trong ${Date.now() - t0}ms`);
  });

  await t.test("nguồn RTSP chết → stream fail-closed, không treo socket vô hạn", async () => {
    await compose(["stop", "rtsp-source"]);
    await pollUntil(async () => !(await mtxPathReady()), 30_000, 500, "mediamtx path offline sau khi stop publisher");
    const res = await fetch(base + streamUrl, { headers: { Cookie: ownerCookie } });
    if (res.status === 200 && res.body) {
      // go2rtc mở 200 rồi im lặng: watchdog idle=4000ms phải kết thúc trong idle*3.
      const reader = res.body.getReader();
      const t0 = Date.now();
      let terminated = false, bytes = 0;
      try {
        while (Date.now() - t0 < APP_IDLE_MS * 3) {
          const { done, value } = await reader.read();
          if (done) { terminated = true; break; }
          bytes += value.length;
        }
      } catch { terminated = true; }
      assert.ok(terminated, `stream tới nguồn chết phải kết thúc bằng watchdog ≤${APP_IDLE_MS * 3}ms, không treo (bytes=${bytes})`);
      report.push(`PASS: nguồn chết → 200 mở nhưng body kết thúc sau ${(Date.now() - t0) / 1000}s (idle watchdog ${APP_IDLE_MS}ms), ${bytes} bytes`);
    } else {
      assert.ok([502, 503].includes(res.status), `status phải 502/503 khi upstream chết, got ${res.status}`);
      report.push(`PASS: nguồn chết → route trả ${res.status} fail-closed (không stream rỗng giả)`);
    }
    const cams = await call("/api/cameras");
    const cam = cams.data.find((c: any) => c.id === camId);
    assert.ok(cam && cam.status !== "online", `danh sách camera phải hiển thị Offline (status=${cam?.status})`);
    const ev = await call("/api/events", "POST", { cameraId: camId, type: "manual", label: `${prefix} offline check`, priority: "normal" });
    assert.equal(ev.status, 201, "sự kiện thủ công phải ghi được khi camera offline");
    const list = await call(`/api/events?camera=${camId}&limit=5`);
    assert.ok(list.data.items.some((e: any) => e.id === ev.data.id), "sự kiện phải đẩy lên feed đúng camera");
    report.push("PASS: camera offline → status hiển thị offline + sự kiện manual push đúng feed");
  });

  await t.test("UI badge offline (Playwright, skip nếu chromium chưa cài)", async (tt) => {
    let browser;
    try {
      const { chromium } = await import("@playwright/test");
      browser = await chromium.launch({ headless: true });
    } catch { tt.skip("chromium chưa cài — npx playwright install chromium để chạy nhánh này"); return; }
    try {
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: "dai_session", value: ownerCookie.split("=")[1], url: base }]);
      const page = await ctx.newPage();
      await page.goto(base + "/camera");
      await page.getByLabel("Chọn camera").selectOption({ label: `${prefix} fixture – camnet 192.168.99.0/24` });
      await page.getByText("Mất kết nối camera", { exact: true }).waitFor({ timeout: 20_000 });
      report.push("PASS: UI hiển thị 'Mất kết nối camera' khi nguồn RTSP chết");
      await ctx.close();
    } finally { await browser.close(); }
  });

  await t.test("reconnect sau mất nguồn RTSP: p95 ≤ 5s", async () => {
    const latencies: number[] = [];
    for (let i = 0; i < 5; i++) {
      await compose(["stop", "rtsp-source"]);
      await pollUntil(async () => !(await mtxPathReady()), 30_000, 500, "path offline");
      await compose(["start", "rtsp-source"]);
      await pollUntil(mtxPathReady, 45_000, 300, "path ready + publisher quay lại");
      const t0 = Date.now();
      const con = await call(`/api/cameras/${camId}/connect`, "POST", {});
      assert.equal(con.status, 200, `connect phải re-register được, got ${con.status}`);
      const res = await fetch(base + streamUrl, { headers: { Cookie: ownerCookie }, signal: AbortSignal.timeout(20_000) });
      if (res.status !== 200) { latencies.push(20_000); continue; }
      let firstAt = 0;
      const feed = mjpegSplitter(() => { if (!firstAt) firstAt = Date.now() - t0; });
      const reader = res.body!.getReader();
      try {
        while (!firstAt && Date.now() - t0 < 20_000) {
          const { done, value } = await reader.read();
          if (done) break;
          feed(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      latencies.push(firstAt || 20_000);
      await wait(500);
    }
    reconnectSamples.push(...latencies);
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
    assert.ok(p95 <= 5_000, `reconnect p95 phải ≤5s, samples=${latencies.join(",")} p95=${p95}ms`);
    report.push(`PASS: reconnect samples ${latencies.join("ms, ")}ms → p95=${p95}ms ≤ 5000ms`);
  });
});
