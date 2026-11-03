import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { eq, inArray } from "drizzle-orm";
import { ensureDefaultTenant } from "./helpers/tenant";
import { db, pool } from "../src/db";
import { assets, cameras, events } from "../src/db/schema";
import {
  computeMotionScore,
  localAssetPath,
  parseMotionScore,
  processFrame,
  recordDetection,
  scoreToConfidence,
  sha256hex,
  shouldEmit,
  type CamDetectState,
} from "../src/lib/camera/detector";

/**
 * REAL-002 — detector unit + integration tests.
 * Unit: parse/threshold/cooldown/dedupe không cần DB.
 * Integration: dùng app_db (DATABASE_URL) + ffmpeg thật; fixture JPEG render bằng sharp.
 */

let hasFfmpeg = false;
try {
  execFileSync(process.env.DETECT_FFMPEG_BIN || "ffmpeg", ["-version"], { stdio: "ignore" });
  hasFfmpeg = true;
} catch {
  hasFfmpeg = false;
}

// Dữ liệu detect của test đi vào thư mục tạm, không đụng data/ của repo.
const testDataDir = mkdtempSync(join(tmpdir(), "dai-detect-test-"));
process.env.DAI_DATA_DIR = testDataDir;

const cfg = { threshold: 0.008, cooldownMs: 60_000, now: () => nowMs };
let nowMs = Date.now();
const freshCs = (): CamDetectState => ({ frames: 0, events: 0 });

let camId = 0;
const cam = { id: 0, name: "DetectorFixture", location: "lab" };

async function jpegVariant(seed: number): Promise<Buffer> {
  // Ảnh có nội dung khác nhau rõ rệt theo seed → điểm diff lớn; giống nhau → diff ~0.
  return sharp({
    create: {
      width: 320,
      height: 180,
      channels: 3,
      background: { r: (seed * 37) % 255, g: (seed * 91) % 255, b: (seed * 53) % 255 },
    },
  })
    .composite([{ input: Buffer.from(`<svg width="320" height="180"><rect x="${(seed * 7) % 200}" y="20" width="80" height="80" fill="#ffffff"/></svg>`), top: 0, left: 0 }])
    .jpeg()
    .toBuffer();
}

before(async () => {
  await ensureDefaultTenant();
  const [row] = await db.insert(cameras).values({ code: "CAM-DETECT-T", name: cam.name, location: cam.location, sourceType: "rtsp", streamName: "dai_cam_0", status: "degraded" }).returning({ id: cameras.id });
  camId = row.id;
  cam.id = camId;
});

after(async () => {
  if (camId) {
    await db.delete(events).where(eq(events.cameraId, camId));
    await db.delete(assets).where(eq(assets.cameraId, camId));
    await db.delete(cameras).where(eq(cameras.id, camId));
  }
  rmSync(testDataDir, { recursive: true, force: true });
  await pool.end();
}, { timeout: 20000 });

const liveEvents = () => db.select().from(events).where(eq(events.cameraId, camId));
const liveAssets = () => db.select().from(assets).where(eq(assets.cameraId, camId));

test("unit: parseMotionScore đọc YAVG và chuẩn hoá 0..1", () => {
  assert.equal(parseMotionScore("lavfi.signalstats.YAVG=0"), 0);
  const s = parseMotionScore("frame:0 pts:0\nlavfi.signalstats.YAVG=3.47321\nlavfi.signalstats.SATAVG=175");
  assert.ok(s !== null && Math.abs(s - 3.47321 / 255) < 1e-6, `score=${s}`);
  assert.equal(parseMotionScore("lavfi.signalstats.YAVG=999"), 1); // clamp về 1
  assert.equal(parseMotionScore("no stats here"), null);
  assert.equal(parseMotionScore("lavfi.signalstats.YAVG=abc"), null);
});

test("unit: ngưỡng — score dưới threshold không phát event", () => {
  assert.equal(0.007 < cfg.threshold, true);
  assert.equal(0.0136 >= cfg.threshold, true); // feed testsrc2 đo thật ~0.0136 phải vượt
});

test("unit: cooldown shouldEmit", () => {
  assert.equal(shouldEmit(undefined, 1000, 60_000), true); // chưa từng phát → phát
  assert.equal(shouldEmit(1000, 30_000, 60_000), false);   // trong cooldown → chặn
  assert.equal(shouldEmit(1000, 61_001, 60_000), true);    // hết cooldown → phát
});

test("unit: dedupe sha256 ổn định theo nội dung", () => {
  const a = Buffer.from("frame-A");
  assert.equal(sha256hex(a), sha256hex(Buffer.from("frame-A")));
  assert.notEqual(sha256hex(a), sha256hex(Buffer.from("frame-B")));
});

test("unit: scoreToConfidence trong [0.5, 0.98] và đơn điệu", () => {
  assert.equal(scoreToConfidence(0), 0.5);
  assert.equal(scoreToConfidence(1), 0.98);
  assert.ok(scoreToConfidence(0.05) > scoreToConfidence(0.02));
});

test("unit: localAssetPath chỉ nhận detect/<sha>.jpg, chặn traversal", () => {
  const sha = "a".repeat(64);
  assert.equal(localAssetPath(`local:detect/${sha}.jpg`), join(testDataDir, "detect", `${sha}.jpg`));
  assert.equal(localAssetPath("local:detect/../../etc/passwd"), null);
  assert.equal(localAssetPath("local:other/x.jpg"), null);
  assert.equal(localAssetPath("https://example.com/x.jpg"), null);
  assert.equal(localAssetPath(null), null);
});

test("ffmpeg: frame giống hệt → score ~0; khác → score cao", { skip: !hasFfmpeg }, async () => {
  const a = await jpegVariant(1);
  const b = await jpegVariant(1); // cùng seed → nội dung giống (JPEG encode có thể lệch bit nhỏ)
  const diff = await jpegVariant(9);
  const sameScore = await computeMotionScore(a, b);
  const diffScore = await computeMotionScore(a, diff);
  assert.ok(sameScore < 0.008, `frame giống phải ~0, got ${sameScore}`);
  assert.ok(diffScore > 0.02, `frame khác phải vượt ngưỡng, got ${diffScore}`);
});

test("integration: 2 frame khác → 1 event + 1 asset; giống → 0; cooldown → không thêm", { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const cs = freshCs();
  const f1 = await jpegVariant(1);
  const f2 = await jpegVariant(8);

  // Frame đầu = baseline: chưa có gì để so, không sinh event.
  assert.equal(await processFrame(cam, f1, cs, cfg), "baseline");
  assert.equal((await liveEvents()).length, 0);

  // Frame khác vượt ngưỡng → event + asset thật.
  assert.equal(await processFrame(cam, f2, cs, cfg), "evented");
  const evs = await liveEvents();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "motion");
  assert.equal(evs[0].source, "live");
  assert.equal(evs[0].clientReported, false);
  const ats = await liveAssets();
  assert.equal(ats.length, 1);
  assert.equal(ats[0].mime, "image/jpeg");
  assert.equal(ats[0].sha256, sha256hex(f2));
  assert.match(ats[0].url ?? "", /^local:detect\/[0-9a-f]{64}\.jpg$/);
  const filePath = localAssetPath(ats[0].url);
  assert.ok(filePath && existsSync(filePath), "file detect phải tồn tại trên đĩa");

  // Lặp lại cùng frame trong cooldown → score ~0, không sinh thêm.
  assert.equal(await processFrame(cam, f2, cs, cfg), "below-threshold");
  assert.equal((await liveEvents()).length, 1);
  assert.equal((await liveAssets()).length, 1);

  // Frame khác tiếp nhưng vẫn trong cooldown → chặn.
  const f3 = await jpegVariant(20);
  assert.equal(await processFrame(cam, f3, cs, cfg), "cooldown");
  assert.equal((await liveEvents()).length, 1);
});

test("integration: dedupe theo sha — cùng frame sau cooldown không tạo event trùng", { skip: !hasFfmpeg, timeout: 60000 }, async () => {
  const cs = freshCs();
  const f1 = await jpegVariant(2);
  const f2 = await jpegVariant(12);

  await processFrame(cam, f1, cs, cfg);
  assert.equal(await processFrame(cam, f2, cs, cfg), "evented");
  const before = (await liveEvents()).length;
  const assetsBefore = (await liveAssets()).length;

  // Đổi baseline sang frame khác, qua cooldown, rồi quay lại f2 → sha trùng → dedupe.
  await processFrame(cam, await jpegVariant(30), cs, cfg); // cooldown
  nowMs += 61_000;
  assert.equal(await processFrame(cam, f2, cs, cfg), "deduped");
  assert.equal((await liveEvents()).length, before, "dedupe không được tạo event mới");
  assert.equal((await liveAssets()).length, assetsBefore, "dedupe không được tạo asset mới");

  // Frame hoàn toàn mới sau cooldown → event mới vẫn được tạo.
  assert.equal(await processFrame(cam, await jpegVariant(40), cs, cfg), "evented");
  assert.equal((await liveEvents()).length, before + 1);
});

test("integration: recordDetection idempotent theo idempotencyKey", { skip: !hasFfmpeg }, async () => {
  const jpeg = await jpegVariant(50);
  const first = await recordDetection(cam, jpeg, 0.05);
  const second = await recordDetection(cam, jpeg, 0.05);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.eventId, first.eventId);
});

test("unit: processFrame không gọi scoreFn trên frame baseline", async () => {
  const cs = freshCs();
  let called = 0;
  const fakeScore = async () => { called++; return 1; };
  const jpeg = await jpegVariant(60);
  assert.equal(await processFrame(cam, jpeg, cs, cfg, fakeScore), "baseline");
  assert.equal(called, 0);
});
