import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeImages } from "@/db/schema";
import { HttpError } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { getItem } from "@/lib/knowledge/items";
import { readLocalAsset } from "@/lib/camera/detector";
import { encodeImage } from "@/lib/retail/encoder";
import { embedStatus, upsertEmbedding } from "@/lib/retail/embedding-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Đọc bytes của ảnh: ưu tiên `data` base64, sau đó file `local:` trên đĩa. */
async function assetBytes(url: string | null, data: string | null): Promise<Buffer | null> {
  if (data && data.length > 64) {
    const b = Buffer.from(data, "base64");
    if (b.length > 0) return b;
  }
  if (url) {
    const local = await readLocalAsset(url);
    if (local) return local;
  }
  return null;
}

/**
 * POST /api/products/[id]/embed — tạo/cập nhật embedding cho ảnh đã xác minh (T-1361).
 * Idempotent theo (item, ảnh, model, version): gọi lại chỉ ghi đè vector.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ tenantId }) => {
    const { id } = await ctx.params;
    const itemId = Number(id);
    if (!Number.isInteger(itemId) || itemId <= 0) throw new HttpError(400, "INVALID_ID", "id sản phẩm không hợp lệ.");

    const item = await getItem(tenantId, itemId);
    if (!item) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy sản phẩm trong cửa hàng này.");

    const only = Number(new URL(req.url).searchParams.get("imageId"));
    const conds = [
      eq(knowledgeImages.tenantId, tenantId),
      eq(knowledgeImages.itemId, itemId),
      isNull(knowledgeImages.deletedAt),
    ];
    if (Number.isInteger(only) && only > 0) conds.push(eq(knowledgeImages.id, only));

    const images = await db
      .select({ id: knowledgeImages.id, assetId: knowledgeImages.assetId })
      .from(knowledgeImages)
      .where(and(...conds));

    if (!images.length) throw new HttpError(422, "NO_IMAGES", "Sản phẩm chưa có ảnh nào để học.");

    let encoded = 0;
    let skipped = 0;
    let totalMs = 0;
    const errors: string[] = [];

    for (const img of images) {
      const res = await db.execute(
        sql`select url, data from assets where id = ${img.assetId} and tenant_id = ${tenantId} limit 1`
      );
      const asset = (res.rows?.[0] ?? null) as { url: string | null; data: string | null } | null;
      const buf = asset ? await assetBytes(asset.url, asset.data) : null;
      if (!buf) {
        skipped += 1;
        errors.push(`ảnh ${img.id}: không đọc được nội dung`);
        continue;
      }
      const { vec, ms } = await encodeImage(buf);
      await upsertEmbedding({ tenantId, itemId, imageId: Number(img.id), vec });
      encoded += 1;
      totalMs += ms;
    }

    return Response.json({
      ok: encoded > 0,
      encoded,
      skipped,
      avgMs: encoded ? Math.round((totalMs / encoded) * 10) / 10 : null,
      errors,
    });
  });
}

/**
 * GET /api/products/[id]/embed — trạng thái học của một sản phẩm (T-1362).
 * `ready` = đã có ít nhất 1 ảnh được tạo vector ⇒ nhận diện được.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("read", async ({ tenantId }) => {
    const { id } = await ctx.params;
    const itemId = Number(id);
    if (!Number.isInteger(itemId) || itemId <= 0) throw new HttpError(400, "INVALID_ID", "id sản phẩm không hợp lệ.");
    const item = await getItem(tenantId, itemId);
    if (!item) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy sản phẩm trong cửa hàng này.");
    return Response.json({ itemId, ...(await embedStatus(tenantId, itemId)) });
  });
}
