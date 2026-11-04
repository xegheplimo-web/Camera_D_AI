/**
 * P3 — persistence layout tường camera vào app_settings (bảng GLOBAL, không có
 * tenant_id): tự namespace key theo tenant+user để hai tenant/user không bao
 * giờ đọc nhầm layout của nhau. Route và test dùng chung đường này — không để
 * route tự build key lệch format.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { normalizeLayout, type WallTile } from "./layout";

export function wallLayoutKey(tenantId: number, userId: number): string {
  return `wall:tenant:${tenantId}:user:${userId}`;
}

/**
 * Đọc layout đã lưu cho (tenant,user), chuẩn hoá lại theo validIds hiện tại —
 * camera bị xoá/ngoài tenant tự rơi ra. null = chưa từng lưu ⇒ route tự default.
 */
export async function loadWallLayout(tenantId: number, userId: number, validIds: number[]): Promise<WallTile[] | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, wallLayoutKey(tenantId, userId)))
    .limit(1);
  if (!row) return null;
  return normalizeLayout((row.value as { tiles?: unknown } | null)?.tiles, validIds);
}

/** Validate raw theo validIds (id tenant khác bị drop, KHÔNG lưu) rồi upsert. */
export async function saveWallLayout(tenantId: number, userId: number, raw: unknown, validIds: number[]): Promise<WallTile[]> {
  const tiles = normalizeLayout(raw, validIds);
  const value = { tiles };
  await db
    .insert(appSettings)
    .values({ key: wallLayoutKey(tenantId, userId), value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  return tiles;
}
