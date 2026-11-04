import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { HttpError } from "@/lib/http-guard";
import type { SessionPayload } from "@/lib/token";

/**
 * Tenant nền tảng (platform tenant) — chủ sở hữu cấu hình toàn cục.
 * `app_settings` là bảng GLOBAL (không có tenant_id), nên chỉ tenant này được ghi.
 * Seed/migration luôn tạo tenant id 1 (xem migrations/008_tenants.sql).
 */
export const PLATFORM_TENANT_ID = 1;

/**
 * Tenant của phiên — luôn resolve từ users.tenant_id (T-1333) phía server;
 * client không bao giờ được tin cậy để khai báo tenant. Mọi truy vấn
 * knowledge/camera_settings đều lọc theo giá trị này.
 */
export async function tenantIdOf(session: SessionPayload): Promise<number> {
  const [row] = await db.select({ tenantId: users.tenantId }).from(users).where(eq(users.id, session.sub)).limit(1);
  if (!row) throw new HttpError(401, "NO_TENANT", "Phiên không thuộc tenant hợp lệ.");
  return row.tenantId;
}
