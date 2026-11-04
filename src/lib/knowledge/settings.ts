import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { cameraSettings, cameras } from "@/db/schema";
import { normalizeFeatures, type CameraFeatureId } from "@/lib/camera/features";
import { HttpError } from "@/lib/http-guard";
import { asObject, denied } from "./http";

export const CAMERA_PROFILES = ["family", "shop", "warehouse", "parking", "factory", "custom"] as const;
export type CameraSettingsRow = typeof cameraSettings.$inferSelect;

/**
 * Capabilities do server tính — phản ánh tính năng deployment THẬT SỰ có,
 * không phải cờ cấu hình. Phase 1 chưa có recorder/detector/push pipeline
 * nên `record` luôn false kể cả khi record_enabled bật.
 */
function capabilities(_row: CameraSettingsRow) {
  void _row;
  return { record: false };
}

export function settingsView(row: CameraSettingsRow) {
  const featureFlags: Record<CameraFeatureId, boolean> = normalizeFeatures(row.features);
  return { ...row, capabilities: capabilities(row), featureFlags };
}

/**
 * Mỗi camera trong tenant có đúng 1 hàng settings: migration backfill các camera
 * hiện hữu; camera tạo sau được lazy-create khi ai đó đọc/sửa settings lần đầu.
 */
export async function ensureCameraSettings(tenantId: number, cameraId: number): Promise<CameraSettingsRow | null> {
  const [cam] = await db.select({ id: cameras.id }).from(cameras)
    .where(and(eq(cameras.id, cameraId), eq(cameras.tenantId, tenantId))).limit(1);
  if (!cam) return null;
  await db.insert(cameraSettings).values({ cameraId, tenantId })
    .onConflictDoNothing({ target: cameraSettings.cameraId });
  const [row] = await db.select().from(cameraSettings)
    .where(and(eq(cameraSettings.cameraId, cameraId), eq(cameraSettings.tenantId, tenantId))).limit(1);
  return row ?? null;
}

/** Bản chắc chắn cho route đọc: camera không tồn tại/khác tenant ⇒ reject 404. */
export async function requireCameraSettings(tenantId: number, cameraId: number): Promise<CameraSettingsRow> {
  const row = await ensureCameraSettings(tenantId, cameraId);
  if (!row) return denied("camera", cameraId);
  return row;
}

export type SettingsPatchResult = { ok: true; row: CameraSettingsRow } | { ok: false; row: CameraSettingsRow };

/** PATCH có revision bắt buộc; compare-and-swap ngay trong UPDATE chống ghi đè lạc hậu. */
export async function patchCameraSettings(tenantId: number, cameraId: number, body: unknown): Promise<SettingsPatchResult> {
  const row = await ensureCameraSettings(tenantId, cameraId);
  if (!row) return denied("camera", cameraId);
  const b = asObject(body);
  if (!Number.isSafeInteger(b.revision)) throw new HttpError(400, "REVISION_REQUIRED", "PATCH bắt buộc revision (integer) của bản settings hiện tại.");
  if (b.revision !== row.revision) return { ok: false, row };

  const set: Partial<typeof cameraSettings.$inferInsert> = {};
  if ("profile" in b) {
    if (!CAMERA_PROFILES.includes(b.profile as (typeof CAMERA_PROFILES)[number]))
      throw new HttpError(400, "INVALID_PROFILE", `profile phải là một trong: ${CAMERA_PROFILES.join("|")}.`);
    set.profile = b.profile as string;
  }
  if ("features" in b) {
    const v = b.features;
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "INVALID_FEATURES", "features phải là object JSON.");
    set.features = v as Record<string, unknown>;
  }
  for (const key of ["recordEnabled", "recordAudio", "notifyEnabled"] as const) {
    if (key in b) {
      if (typeof b[key] !== "boolean") throw new HttpError(400, "INVALID_FLAG", `${key} phải là boolean.`);
      set[key] = b[key] as boolean;
    }
  }
  if ("retentionDays" in b) {
    const v = b.retentionDays;
    if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 365)
      throw new HttpError(400, "INVALID_RETENTION", "retentionDays phải là số nguyên 1–365.");
    set.retentionDays = v as number;
  }
  if ("detectFps" in b) {
    const v = b.detectFps;
    if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 30)
      throw new HttpError(400, "INVALID_FPS", "detectFps phải là số nguyên 1–30.");
    set.detectFps = v as number;
  }
  for (const key of ["zones", "countLines", "privacyMasks"] as const) {
    if (key in b) {
      const v = b[key];
      if (!Array.isArray(v) || v.length > 64) throw new HttpError(400, "INVALID_JSON_FIELD", `${key} phải là mảng JSON (tối đa 64 phần tử).`);
      set[key] = v as Record<string, unknown>[];
    }
  }
  if (!Object.keys(set).length) throw new HttpError(400, "EMPTY_PATCH", "Không có thay đổi hợp lệ.");

  const [updated] = await db.update(cameraSettings)
    .set({ ...set, revision: row.revision + 1, updatedAt: new Date() })
    .where(and(eq(cameraSettings.cameraId, cameraId), eq(cameraSettings.revision, row.revision)))
    .returning();
  if (updated) return { ok: true, row: updated };
  // Ai đó đã PATCH xen giữa — đọc lại bản mới nhất để trả conflict đúng.
  const [cur] = await db.select().from(cameraSettings).where(eq(cameraSettings.cameraId, cameraId)).limit(1);
  if (!cur) return denied("camera", cameraId);
  return { ok: false, row: cur };
}
