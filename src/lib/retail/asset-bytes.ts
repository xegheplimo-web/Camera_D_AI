import { sql } from "drizzle-orm";
import { db } from "@/db";
import { HttpError } from "@/lib/http-guard";
import { readLocalAsset } from "@/lib/camera/detector";

const MAX_BASE64 = 12 * 1024 * 1024;

/**
 * Đọc bytes ảnh của một asset TRONG TENANT hiện tại, hoặc giải base64 từ client.
 * Dùng chung cho `/api/recognize` và `/api/recognize/correct` (tránh lặp code).
 */
export async function assetBytes(tenantId: number, assetId: number | null, base64: string | null): Promise<Buffer> {
  if (base64) {
    const raw = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
    if (raw.length > MAX_BASE64) throw new HttpError(413, "IMAGE_TOO_LARGE", "Ảnh quá lớn.");
    const buf = Buffer.from(raw, "base64");
    if (!buf.length) throw new HttpError(400, "INVALID_IMAGE", "Ảnh không hợp lệ.");
    return buf;
  }
  if (!assetId) throw new HttpError(400, "MISSING_IMAGE", "Cần assetId hoặc ảnh.");
  const res = await db.execute(sql`select url, data from assets where id = ${assetId} and tenant_id = ${tenantId} limit 1`);
  const row = (res.rows?.[0] ?? null) as { url: string | null; data: string | null } | null;
  if (!row) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy ảnh trong cửa hàng này.");
  if (row.data && row.data.length > 64) return Buffer.from(row.data, "base64");
  const local = row.url ? await readLocalAsset(row.url) : null;
  if (!local) throw new HttpError(422, "ASSET_NOT_READABLE", "Không đọc được nội dung ảnh.");
  return local;
}
