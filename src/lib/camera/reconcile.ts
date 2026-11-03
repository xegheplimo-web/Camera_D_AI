/**
 * T-1348 — tự phục hồi cấu hình ghi hình sau khi mediaMTX restart.
 *
 * Vì sao cần: path ghi hình của camera thật chỉ tồn tại trong **runtime config**
 * của mediaMTX (thêm qua `/v3/config/paths/add` ở T-1340), không nằm trong
 * `mediamtx.yml`. Đo thật 2026-11-03 19:44: kill mediaMTX rồi start lại ⇒
 * `GET /v3/config/paths/get/dai_cam_441` trả 404, `paths/list` chỉ còn `cam`,
 * số segment đứng nguyên 38 (ghi hình dừng im lặng) cho tới khi có người PATCH
 * settings thủ công.
 *
 * Cách làm: đối chiếu DB (`camera_settings.record_enabled = true`) với trạng thái
 * thật của mediaMTX, bật lại path còn thiếu. Idempotent: path đã ghi đúng thì bỏ
 * qua, không gọi write. Chạy lúc server khởi động và lặp mỗi 60 s.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { cameraSettings, cameras } from "@/db/schema";
import { decryptSource } from "@/lib/camera/stream";
import { ensureRecordingPath, recorderState } from "@/lib/camera/recorder";

export type ReconcileFailure = { cameraId: number; error: string };
export type ReconcileResult = {
  at: string;
  checked: number;
  ensured: number;
  skipped: number;
  failed: ReconcileFailure[];
};

/** Trạng thái lần đối chiếu gần nhất — cho endpoint vận hành nội bộ. */
export const reconcileState: { last: ReconcileResult | null; running: boolean } = { last: null, running: false };

function sourceOf(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decryptSource(ciphertext);
  } catch {
    return null;
  }
}

/**
 * Bật lại path ghi hình cho mọi camera đang bật ghi. Không throw: lỗi từng camera
 * được gom vào `failed` để lần chạy sau thử lại.
 */
export async function reconcileRecordingPaths(): Promise<ReconcileResult> {
  const rows = await db
    .select({
      id: cameras.id,
      streamName: cameras.streamName,
      sourceCiphertext: cameras.sourceCiphertext,
      retentionDays: cameraSettings.retentionDays,
    })
    .from(cameras)
    .innerJoin(cameraSettings, eq(cameraSettings.cameraId, cameras.id))
    .where(and(eq(cameras.enabled, true), eq(cameraSettings.recordEnabled, true), isNotNull(cameras.streamName)));

  const result: ReconcileResult = { at: new Date().toISOString(), checked: rows.length, ensured: 0, skipped: 0, failed: [] };

  for (const row of rows) {
    const streamName = row.streamName ?? "";
    if (!streamName) continue;
    const sourceUrl = sourceOf(row.sourceCiphertext);
    if (!sourceUrl) {
      result.failed.push({ cameraId: row.id, error: "không giải mã được nguồn RTSP" });
      continue;
    }
    const state = await recorderState(streamName);
    if (state.pathExists && state.recording) {
      result.skipped += 1;
      continue;
    }
    const fixed = await ensureRecordingPath({ streamName, sourceUrl, retentionDays: row.retentionDays });
    if (fixed.pathExists && fixed.recording) result.ensured += 1;
    else result.failed.push({ cameraId: row.id, error: fixed.error ?? "không bật lại được ghi hình" });
  }

  reconcileState.last = result;
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Chạy ngay 1 lần rồi lặp mỗi 60 s. An toàn khi gọi nhiều lần (một timer duy nhất). */
export function startRecordingReconcile(): void {
  if (timer) return;
  const tick = async () => {
    if (reconcileState.running) return;
    reconcileState.running = true;
    try {
      await reconcileRecordingPaths();
    } catch (e) {
      reconcileState.last = {
        at: new Date().toISOString(),
        checked: 0,
        ensured: 0,
        skipped: 0,
        failed: [{ cameraId: 0, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }],
      };
    } finally {
      reconcileState.running = false;
    }
  };
  void tick();
  timer = setInterval(tick, 60_000);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopRecordingReconcile(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
