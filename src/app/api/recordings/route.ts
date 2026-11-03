import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { cameraSettings } from "@/db/schema";
import { authorize } from "@/lib/auth-server";
import { HttpError } from "@/lib/http-guard";
import { denied, fail, queryCameraId, withTenant } from "@/lib/knowledge/http";
import { tenantIdOf } from "@/lib/knowledge/tenant";
import {
  findRecordingCamera,
  globalRetentionDays,
  listSegments,
  purgeOldSegments,
  recordingKeysFor,
  storageStatus,
} from "@/lib/recordings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function queryDate(u: URL, name: string): Date | undefined {
  const raw = u.searchParams.get(name);
  if (raw === null) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "INVALID_RANGE", `Tham số ${name} phải là thời điểm RFC3339 hợp lệ.`);
  return d;
}

/** GET /api/recordings?cameraId&from&to — danh sách segment đọc từ đĩa + storage; không cameraId → chỉ storage. */
export async function GET(req: Request) {
  return withTenant("read", async ({ tenantId }) => {
    const u = new URL(req.url);
    const cameraId = queryCameraId(u);
    const from = queryDate(u, "from");
    const to = queryDate(u, "to");
    const storage = await storageStatus();
    let keys: string[] = [];
    let segments: Awaited<ReturnType<typeof listSegments>> = [];
    if (cameraId !== undefined) {
      const cam = await findRecordingCamera(tenantId, cameraId);
      if (!cam) return denied("camera", cameraId);
      keys = recordingKeysFor(cam);
      const lists = await Promise.all(keys.map((k) => listSegments(k, from, to)));
      segments = lists.flat().sort((a, b) => a.start.getTime() - b.start.getTime());
    }
    return Response.json({ cameraId: cameraId ?? null, keys, segments, storage });
  });
}

/** DELETE /api/recordings?cameraId&olderThanDays=N — purge thủ công (owner); audit recording.purge. */
export async function DELETE(req: Request) {
  const auth = await authorize("delete"); // chỉ owner có quyền delete trong matrix
  if (auth.response) return auth.response;
  try {
    const tenantId = await tenantIdOf(auth.session);
    const u = new URL(req.url);
    const cameraId = queryCameraId(u);
    const rawDays = u.searchParams.get("olderThanDays");
    let days = rawDays === null ? undefined : Number(rawDays);
    if (days !== undefined && (!Number.isSafeInteger(days) || days < 1 || days > 365))
      throw new HttpError(400, "INVALID_DAYS", "olderThanDays phải là số nguyên 1–365.");

    if (cameraId !== undefined) {
      const cam = await findRecordingCamera(tenantId, cameraId);
      if (!cam) await denied("camera", cameraId); // await: denied throw — thiếu await thì rejection thoát catch → 500
      if (days === undefined) {
        // Cùng thứ tự với runVideoRetention: camera_settings → cameras.retention_days → global.
        const [s] = await db
          .select({ d: cameraSettings.retentionDays })
          .from(cameraSettings)
          .where(and(eq(cameraSettings.cameraId, cam.id), eq(cameraSettings.tenantId, tenantId)))
          .limit(1);
        days = s?.d ?? (cam.retentionDays && cam.retentionDays > 0 ? cam.retentionDays : await globalRetentionDays());
      }
      const keys = recordingKeysFor(cam);
      const total = { deleted: 0, bytes: 0, files: [] as string[] };
      for (const k of keys) {
        const r = await purgeOldSegments(days, { cameraKey: k, actor: auth.session });
        total.deleted += r.deleted;
        total.bytes += r.bytes;
        total.files.push(...r.files);
      }
      return Response.json({ cameraId, keys, olderThanDays: days, deleted: total.deleted, bytes: total.bytes });
    }

    if (days === undefined) days = await globalRetentionDays();
    const r = await purgeOldSegments(days, { actor: auth.session });
    return Response.json({ olderThanDays: days, deleted: r.deleted, bytes: r.bytes });
  } catch (e) {
    return fail(e);
  }
}
