/**
 * Server-only camera motion detector (REAL-002). Started once from
 * instrumentation register(); never expose internals to the browser.
 *
 * Pipeline mỗi tick: camera RTSP (enabled + streamName) → go2rtc
 * /api/frame.jpeg → so khung JPEG hiện tại với khung trước bằng ffmpeg
 * (blend=difference + signalstats, điểm = YAVG/255 ∈ [0..1]) → nếu vượt
 * ngưỡng và ngoài cooldown thì ghi asset (file + sha256, chống trùng theo sha)
 * và event source='live', clientReported=false.
 *
 * Hai lớp bật/tắt: env DETECT_ENABLED=true cho phép vòng lặp chạy, còn setting
 * detectEnabled (bảng app_settings, đổi được lúc runtime) quyết định có lấy
 * frame/ghi sự kiện hay không. State nằm trên globalThis để instrumentation,
 * route nội bộ và /api/orchestration nhìn chung một bản trong cùng process.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { assets, cameras, events } from "@/db/schema";
import { getSettings } from "@/lib/settings";
import { go2rtcBase } from "@/lib/camera/stream";

/* ---------------- cấu hình ---------------- */

function envNum(name: string, fallback: number, min: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export function detectorConfig() {
  return {
    /** Cổng cứng: chỉ vòng lặp chỉ chạy khi env này đúng "true" (mặc định tắt). */
    envEnabled: (process.env.DETECT_ENABLED ?? "").toLowerCase() === "true",
    intervalMs: envNum("DETECT_INTERVAL_MS", 5000, 1000),
    /** Ngưỡng chuyển động: trung bình chênh lệch luma chuẩn hoá (YAVG/255). 0.008 ≈ 2/255. */
    threshold: envNum("DETECT_MOTION_THRESHOLD", 0.008, 0),
    cooldownMs: envNum("DETECT_COOLDOWN_SECONDS", 60, 1) * 1000,
    fetchTimeoutMs: envNum("DETECT_FETCH_TIMEOUT_MS", 3000, 500),
    ffmpegBin: process.env.DETECT_FFMPEG_BIN || "ffmpeg",
    ffmpegTimeoutMs: envNum("DETECT_FFMPEG_TIMEOUT_MS", 8000, 1000),
  };
}

/* ---------------- hàm thuần (unit-testable) ---------------- */

/** Parse YAVG từ output của ffmpeg signalstats → điểm chuyển động 0..1. */
export function parseMotionScore(text: string): number | null {
  const m = /signalstats\.YAVG\s*=\s*([\d.]+)/.exec(text) ?? /YAVG\s*=\s*([\d.]+)/.exec(text);
  if (!m) return null;
  const yavg = Number(m[1]);
  if (!Number.isFinite(yavg) || yavg < 0) return null;
  return Math.min(1, yavg / 255);
}

/** Cooldown theo camera: chỉ phát event khi lần cuối đã quá cooldownMs. */
export function shouldEmit(lastEventAt: number | undefined, now: number, cooldownMs: number): boolean {
  return lastEventAt === undefined || now - lastEventAt >= cooldownMs;
}

/** Điểm 0..1 → confidence ghi vào event (đoạn [0.5, 0.98], đơn điệu tăng). */
export function scoreToConfidence(score: number): number {
  const clamped = Math.max(0, Math.min(1, score));
  return Math.min(0.98, Math.round((0.5 + clamped * 4) * 100) / 100);
}

export function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/* ---------------- lưu trữ file (asset dạng local:) ---------------- */

export function dataDir(): string {
  return process.env.DAI_DATA_DIR || join(process.cwd(), "data");
}

const LOCAL_URL = "local:";

/** Giải url "local:detect/<sha>.jpg" về path trên đĩa; null nếu sai định dạng. */
export function localAssetPath(url: string | null): string | null {
  if (!url || !url.startsWith(LOCAL_URL)) return null;
  const rel = url.slice(LOCAL_URL.length);
  if (!/^detect\/[0-9a-f]{64}\.jpg$/.test(rel)) return null;
  return join(dataDir(), "detect", basename(rel));
}

export async function readLocalAsset(url: string): Promise<Buffer | null> {
  const path = localAssetPath(url);
  if (!path) return null;
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/* ---------------- ffmpeg ---------------- */

function runFfmpeg(args: string[], timeoutMs: number, bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let out = "";
    let errTail = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg quá thời gian"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { errTail = (errTail + d.toString("utf8")).slice(-400); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ffmpeg thoát mã ${code}${errTail ? `: ${errTail.split("\n").at(-1)}` : ""}`));
    });
  });
}

/**
 * Điểm chuyển động giữa 2 frame JPEG: blend difference → signalstats YAVG/255.
 * 0 = giống hệt; càng lớn càng khác. File tạm trong os.tmpdir, dọn trong finally.
 */
export async function computeMotionScore(prev: Buffer, cur: Buffer, cfg = detectorConfig()): Promise<number> {
  const stamp = randomBytes(8).toString("hex");
  const a = join(tmpdir(), `dai-detect-${stamp}-a.jpg`);
  const b = join(tmpdir(), `dai-detect-${stamp}-b.jpg`);
  await writeFile(a, prev);
  await writeFile(b, cur);
  try {
    const out = await runFfmpeg(
      ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
        "-i", a, "-i", b,
        "-filter_complex", "blend=all_mode=difference,signalstats,metadata=mode=print:file=-",
        "-f", "null", "-"],
      cfg.ffmpegTimeoutMs,
      cfg.ffmpegBin
    );
    const score = parseMotionScore(out);
    if (score === null) throw new Error("Không đọc được điểm signalstats từ ffmpeg");
    return score;
  } finally {
    await rm(a, { force: true }).catch(() => {});
    await rm(b, { force: true }).catch(() => {});
  }
}

/* ---------------- ghi asset + event ---------------- */

async function ensureDetectAsset(jpeg: Buffer, sha: string, cameraId: number): Promise<number> {
  const [existing] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.sha256, sha), eq(assets.origin, "detect"), eq(assets.cameraId, cameraId)))
    .limit(1);
  if (existing) return existing.id;

  const dir = join(dataDir(), "detect");
  await mkdir(dir, { recursive: true });
  // flag "wx": sha trùng → file đã có, không ghi đè; lỗi khác vẫn ném ra.
  await writeFile(join(dir, `${sha}.jpg`), jpeg, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  const [row] = await db
    .insert(assets)
    .values({
      kind: "image",
      mime: "image/jpeg",
      sha256: sha,
      url: `${LOCAL_URL}detect/${sha}.jpg`,
      sizeBytes: jpeg.length,
      origin: "detect",
      cameraId,
      uploadedBy: "detector",
    })
    .returning({ id: assets.id });
  return row.id;
}

/** Ghi 1 lần phát hiện: asset chống trùng theo sha, event chống trùng theo idempotencyKey. */
export async function recordDetection(
  cam: { id: number; name: string; location: string },
  jpeg: Buffer,
  score: number
): Promise<{ eventId: number; assetId: number; duplicate: boolean }> {
  const sha = sha256hex(jpeg);
  const idem = `detect-${cam.id}-${sha.slice(0, 24)}`;
  const [dupe] = await db
    .select({ id: events.id, assetId: events.assetId })
    .from(events)
    .where(eq(events.idempotencyKey, idem))
    .limit(1);
  if (dupe) return { eventId: dupe.id, assetId: dupe.assetId ?? 0, duplicate: true };

  const assetId = await ensureDetectAsset(jpeg, sha, cam.id);
  const [row] = await db
    .insert(events)
    .values({
      cameraId: cam.id,
      type: "motion",
      label: `Phát hiện chuyển động tại ${cam.name} – ${cam.location}`,
      note: `Điểm chuyển động ${score.toFixed(4)} (YAVG/255, ngưỡng ${detectorConfig().threshold})`,
      confidence: scoreToConfidence(score),
      assetId,
      tags: ["chuyển động", "phát hiện tự động"],
      idempotencyKey: idem,
      source: "live",
      clientReported: false,
      createdBy: "detector",
    })
    .returning({ id: events.id });
  return { eventId: row.id, assetId, duplicate: false };
}

/* ---------------- quyết định mỗi frame ---------------- */

export type CamDetectState = {
  prev?: Buffer;
  frames: number;
  events: number;
  lastScore?: number;
  lastEventAt?: number;
  lastCheckedAt?: Date;
  lastError?: string;
  /** Đã seed cooldown từ DB (lastEventAt của event detector gần nhất) chưa — chỉ làm 1 lần/process. */
  cooldownSeeded?: boolean;
};

export type FrameOutcome = "baseline" | "below-threshold" | "cooldown" | "deduped" | "evented";

/** Xử lý 1 frame JPEG của 1 camera: baseline → chấm điểm → cooldown → dedupe → ghi event. */
export async function processFrame(
  cam: { id: number; name: string; location: string },
  jpeg: Buffer,
  cs: CamDetectState,
  cfg: { threshold: number; cooldownMs: number; now: () => number },
  scoreFn: (prev: Buffer, cur: Buffer) => Promise<number> = computeMotionScore
): Promise<FrameOutcome> {
  cs.frames++;
  cs.lastCheckedAt = new Date();
  if (!cs.prev) {
    cs.prev = jpeg;
    return "baseline";
  }
  const score = await scoreFn(cs.prev, jpeg);
  cs.lastScore = score;
  cs.prev = jpeg;
  if (score < cfg.threshold) return "below-threshold";
  const now = cfg.now();
  if (!shouldEmit(cs.lastEventAt, now, cfg.cooldownMs)) return "cooldown";
  const rec = await recordDetection(cam, jpeg, score);
  if (rec.duplicate) return "deduped";
  cs.lastEventAt = now;
  cs.events++;
  return "evented";
}

/* ---------------- vòng lặp detector ---------------- */

type DetectorState = {
  running: boolean;
  ticking: boolean;
  timer: ReturnType<typeof setInterval> | null;
  settingEnabled: boolean | null;
  startedAt: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  eventsCreated: number;
  cams: Map<number, CamDetectState>;
};

const globalForDetector = globalThis as typeof globalThis & { __daiDetector?: DetectorState };
const state: DetectorState = (globalForDetector.__daiDetector ??= {
  running: false,
  ticking: false,
  timer: null,
  settingEnabled: null,
  startedAt: null,
  lastTickAt: null,
  lastError: null,
  eventsCreated: 0,
  cams: new Map(),
});

/** Mốc event detector gần nhất của camera trong DB — để cooldown sống qua restart process. */
async function lastDetectorEventAt(cameraId: number): Promise<number | undefined> {
  const [row] = await db
    .select({ happenedAt: events.happenedAt })
    .from(events)
    .where(and(eq(events.cameraId, cameraId), eq(events.createdBy, "detector")))
    .orderBy(desc(events.happenedAt))
    .limit(1);
  return row?.happenedAt?.getTime();
}

async function fetchFrame(streamName: string, timeoutMs: number): Promise<Buffer> {
  if (!/^dai_cam_[0-9]+$/.test(streamName)) throw new Error("Tên stream không hợp lệ");
  const res = await fetch(`${go2rtcBase()}/api/frame.jpeg?${new URLSearchParams({ src: streamName })}`, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`go2rtc trả ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("frame không phải JPEG");
  return buf;
}

async function tick() {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const cfg = detectorConfig();
    const settings = await getSettings();
    state.settingEnabled = settings.detectEnabled;
    const rows = await db
      .select({ id: cameras.id, name: cameras.name, location: cameras.location, streamName: cameras.streamName })
      .from(cameras)
      .where(and(eq(cameras.enabled, true), eq(cameras.sourceType, "rtsp"), isNotNull(cameras.streamName)));
    const liveIds = new Set(rows.map((r) => r.id));
    for (const id of state.cams.keys()) if (!liveIds.has(id)) state.cams.delete(id); // không giữ frame rác của camera đã gỡ
    for (const cam of rows) {
      if (!cam.streamName) continue;
      const cs = state.cams.get(cam.id) ?? { frames: 0, events: 0 };
      state.cams.set(cam.id, cs);
      if (!settings.detectEnabled) {
        cs.prev = undefined; // bỏ baseline cũ: bật lại sẽ chụp baseline mới, không trừ khung qua khoảng tắt
      } else {
        if (cs.cooldownSeeded !== true) {
          cs.cooldownSeeded = true;
          const last = await lastDetectorEventAt(cam.id);
          if (last !== undefined && last > (cs.lastEventAt ?? 0)) cs.lastEventAt = last;
        }
        try {
          const jpeg = await fetchFrame(cam.streamName, cfg.fetchTimeoutMs);
          const outcome = await processFrame(cam, jpeg, cs, { threshold: cfg.threshold, cooldownMs: cfg.cooldownMs, now: () => Date.now() });
          if (outcome === "evented") state.eventsCreated++;
          cs.lastError = undefined;
        } catch (e) {
          // Lỗi từng camera không làm hỏng tick; không log credential (URL chỉ chứa streamName).
          cs.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
        }
      }
    }
    state.lastTickAt = new Date().toISOString();
    state.lastError = null;
  } catch (e) {
    state.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  } finally {
    state.ticking = false;
  }
}

/** Gọi từ instrumentation register(). Không-đốp (no-op) nếu DETECT_ENABLED không bật. */
export function startDetector(): boolean {
  if (state.running) return true;
  if (!detectorConfig().envEnabled) return false;
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.timer = setInterval(() => {
    void tick();
  }, detectorConfig().intervalMs);
  state.timer.unref?.();
  void tick();
  return true;
}

export function stopDetector(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
}

export async function detectorStatus() {
  const cfg = detectorConfig();
  const [{ c: liveEventsDb }] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.source, "live"), eq(events.createdBy, "detector")));
  return {
    running: state.running,
    envEnabled: cfg.envEnabled,
    settingEnabled: state.settingEnabled,
    intervalMs: cfg.intervalMs,
    threshold: cfg.threshold,
    cooldownSeconds: Math.round(cfg.cooldownMs / 1000),
    startedAt: state.startedAt,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    eventsCreated: state.eventsCreated, // event do process hiện tại tạo
    liveEventsDb,                        // tổng event detector trong DB (khớp select count(*))
    cameras: [...state.cams.entries()].map(([cameraId, cs]) => ({
      cameraId,
      frames: cs.frames,
      events: cs.events,
      lastScore: cs.lastScore ?? null,
      lastEventAt: cs.lastEventAt ? new Date(cs.lastEventAt).toISOString() : null,
      lastCheckedAt: cs.lastCheckedAt?.toISOString() ?? null,
      lastError: cs.lastError ?? null,
    })),
  };
}
