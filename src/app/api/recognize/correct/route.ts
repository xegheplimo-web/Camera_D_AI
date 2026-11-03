import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/http-guard";
import { asObject, withTenant } from "@/lib/knowledge/http";
import { assetBytes } from "@/lib/retail/asset-bytes";
import { recordCorrection } from "@/lib/retail/corrections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/recognize/correct — người dùng chọn SKU đúng cho một ảnh (T-1365).
 * Body: { itemId, assetId? , imageBase64?, predictedItemId?, note? }
 */
export async function POST(req: Request) {
  return withTenant("manage", async ({ session, tenantId }) => {
    const body = asObject(await req.json().catch(() => ({})));
    const itemId = Number(body.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) throw new HttpError(400, "INVALID_ITEM", "Thiếu sản phẩm đúng.");
    const predicted = Number(body.predictedItemId);
    const assetId = Number(body.assetId);
    const base64 = typeof body.imageBase64 === "string" ? body.imageBase64 : null;
    const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;

    const buffer = await assetBytes(tenantId, Number.isInteger(assetId) && assetId > 0 ? assetId : null, base64);
    const result = await recordCorrection({
      tenantId,
      itemId,
      predictedItemId: Number.isInteger(predicted) && predicted > 0 ? predicted : null,
      assetId: Number.isInteger(assetId) && assetId > 0 ? assetId : null,
      buffer,
      score: typeof body.score === "number" ? body.score : null,
      margin: typeof body.margin === "number" ? body.margin : null,
      note,
      userId: Number(session.sub) || null,
    });

    await audit("retail.correction", { targetType: "knowledge_item", targetId: itemId, detail: `image=${result.imageId}` });
    return Response.json({ ok: true, ...result });
  });
}
