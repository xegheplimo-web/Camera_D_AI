import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeItems } from "@/db/schema";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/http-guard";
import { asObject, withTenant } from "@/lib/knowledge/http";
import { assetBytes } from "@/lib/retail/asset-bytes";
import { recognizeImage } from "@/lib/retail/recognize-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/recognize — nhận diện sản phẩm từ ảnh (T-1364).
 * Body: { assetId?: number, imageBase64?: string, barcode?: string }
 */
export async function POST(req: Request) {
  return withTenant("read", async ({ tenantId }) => {
    const body = asObject(await req.json().catch(() => ({})));
    const assetId = Number(body.assetId);
    const base64 = typeof body.imageBase64 === "string" ? body.imageBase64 : null;
    const barcode = typeof body.barcode === "string" && body.barcode.trim() ? body.barcode.trim() : null;

    const buffer = await assetBytes(tenantId, Number.isInteger(assetId) && assetId > 0 ? assetId : null, base64);
    const result = await recognizeImage({ tenantId, buffer, barcode });

    const ids = result.alternatives.map((a) => a.itemId);
    const rows = ids.length
      ? await db
          .select({ id: knowledgeItems.id, title: knowledgeItems.title, priceVnd: knowledgeItems.priceVnd })
          .from(knowledgeItems)
          .where(and(eq(knowledgeItems.tenantId, tenantId), inArray(knowledgeItems.id, ids)))
      : [];
    const byId = new Map(rows.map((r) => [Number(r.id), { title: r.title, priceVnd: r.priceVnd }]));

    await audit("retail.recognize", {
      targetType: "knowledge_item",
      targetId: result.itemId,
      detail: `${result.status}/${result.reason} score=${result.score?.toFixed(4) ?? "-"} margin=${result.margin?.toFixed(4) ?? "-"}`,
    });

    return Response.json({
      status: result.status,
      reason: result.reason,
      itemId: result.itemId,
      item: result.itemId ? (byId.get(result.itemId) ?? null) : null,
      score: result.score,
      margin: result.margin,
      barcode: result.barcode,
      barcodeItemId: result.barcodeItemId,
      alternatives: result.alternatives.map((a) => ({ ...a, ...(byId.get(a.itemId) ?? {}) })),
      timing: { encodeMs: Math.round(result.encodeMs * 10) / 10, searchMs: Math.round(result.searchMs * 100) / 100 },
      sharpness: Math.round(result.sharpness * 10) / 10,
    });
  });
}
