import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { cameras } from "@/db/schema";
import { audit, problem } from "@/lib/audit";
import { applyRecordPatch, ensureRecordingPath, recorderState } from "@/lib/camera/recorder";
import { decryptSource } from "@/lib/camera/stream";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { asObject, withTenant } from "@/lib/knowledge/http";
import { patchCameraSettings, requireCameraSettings, settingsView, type CameraSettingsRow } from "@/lib/knowledge/settings";
import { listSegments, recordingKeysFor } from "@/lib/recordings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "INVALID_ID", "Mã camera không hợp lệ.");
  return id;
}

type CamBasics = { streamName: string | null; sourceCiphertext: string | null };

async function cameraBasics(tenantId: number, id: number): Promise<CamBasics | null> {
  const [cam] = await db
    .select({ streamName: cameras.streamName, sourceCiphertext: cameras.sourceCiphertext })
    .from(cameras)
    .where(and(eq(cameras.id, id), eq(cameras.tenantId, tenantId)))
    .limit(1);
  return cam ?? null;
}

/** RTSP đã giải mã phục vụ recorder; lỗi giải mã ⇒ null (coi như không có nguồn). */
function sourceOf(cam: CamBasics | null): string | null {
  if (!cam?.sourceCiphertext) return null;
  try {
    return decryptSource(cam.sourceCiphertext);
  } catch {
    return null;
  }
}

async function anySegmentOnDisk(cam: CamBasics | null): Promise<boolean> {
  if (!cam) return false;
  const lists = await Promise.all(recordingKeysFor(cam).map((k) => listSegments(k)));
  return lists.some((l) => l.length > 0);
}

/**
 * Capabilities do server tính mỗi request — tính năng deployment THẬT SỰ có:
 *   record   = mediaMTX trả lời được API (recorder còn sống)
 *   audio    = runtime tracks của path có codec âm thanh (fail-closed khi không đọc được)
 *   playback = ≥1 segment trên đĩa cho mọi cameraKey của camera, hoặc đang bật ghi
 *   pricing  = luôn false phase này (chưa có model nhận diện sản phẩm)
 *   live/snapshot/ask không có phụ thuộc server-side riêng ⇒ sẵn sàng.
 */
async function capabilities(cam: CamBasics | null, row: CameraSettingsRow) {
  const streamName = cam?.streamName ?? `dai_cam_${row.cameraId}`;
  const [rec, hasSegments] = await Promise.all([recorderState(streamName), anySegmentOnDisk(cam)]);
  const playback = hasSegments || row.recordEnabled;
  const reason: Record<string, string> = { pricing: "Chưa có nhận diện sản phẩm" };
  if (!rec.reachable) reason.record = rec.error ? `Recorder không phản hồi (${rec.error})` : "Recorder mediaMTX chưa chạy";
  if (!playback) reason.playback = "Chưa có đoạn ghi nào";
  return { live: true, playback, snapshot: true, record: rec.reachable, audio: rec.audio, ask: true, pricing: false, reason };
}

/** GET — bộ cài đặt riêng của camera (lazy-create mặc định nếu chưa có) + capabilities do server tính. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("read", async ({ tenantId }) => {
    const id = await paramId(ctx);
    const row = await requireCameraSettings(tenantId, id);
    const cam = await cameraBasics(tenantId, id);
    return Response.json({ ...settingsView(row), capabilities: await capabilities(cam, row) });
  });
}

/**
 * PATCH — sửa settings có optimistic lock: body bắt buộc `revision` khớp bản hiện
 * tại; lệch ⇒ 409 kèm {currentRevision, settings} để client merge lại.
 *
 * Body đụng `recordEnabled` đi qua applyRecordPatch: bật record mà recorder
 * không reachable ⇒ 503 + problem() và DB đứng yên (không báo bật giả); tắt
 * record thì DB ghi trước, recorder theo sau best-effort.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ tenantId }) => {
    const id = await paramId(ctx);
    const body = await readJsonBody(req);
    const b = asObject(body);

    if (typeof b.recordEnabled === "boolean") {
      const row = await requireCameraSettings(tenantId, id);
      const cam = await cameraBasics(tenantId, id);
      const streamName = cam?.streamName ?? `dai_cam_${id}`;
      const sourceUrl = sourceOf(cam);
      const out = await applyRecordPatch({
        enable: b.recordEnabled,
        current: row.recordEnabled,
        streamName,
        sourceUrl,
        retentionDays: row.retentionDays,
        persist: () => patchCameraSettings(tenantId, id, body),
      });
      if (!out.ok) return problem(out.status, out.title, out.detail);
      if (!out.value.ok)
        return Response.json({ currentRevision: out.value.row.revision, settings: settingsView(out.value.row) }, { status: 409 });
      // Đổi retention trong cùng bản PATCH bật ghi ⇒ làm mới recordDeleteAfter (best-effort).
      if (b.recordEnabled && Number.isSafeInteger(b.retentionDays) && b.retentionDays !== row.retentionDays)
        await ensureRecordingPath({ streamName, sourceUrl: sourceUrl ?? "", retentionDays: out.value.row.retentionDays });
      await audit("camera_settings.update", {
        targetType: "camera",
        targetId: id,
        detail: `rev=${out.value.row.revision} record=${out.value.row.recordEnabled}`,
      });
      return Response.json({ ...settingsView(out.value.row), capabilities: await capabilities(cam, out.value.row) });
    }

    const r = await patchCameraSettings(tenantId, id, body);
    if (!r.ok) return Response.json({ currentRevision: r.row.revision, settings: settingsView(r.row) }, { status: 409 });
    await audit("camera_settings.update", { targetType: "camera", targetId: id, detail: `rev=${r.row.revision}` });
    const cam = await cameraBasics(tenantId, id);
    return Response.json({ ...settingsView(r.row), capabilities: await capabilities(cam, r.row) });
  });
}
