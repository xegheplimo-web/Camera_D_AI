import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeItems } from "@/db/schema";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/http-guard";
import { asObject, withTenant } from "@/lib/knowledge/http";
import { readLocalAsset } from "@/lib/camera/detector";
import { recognizeImage } from "@/lib/retail/recognize-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BASE64 = 12 * 1024 * 1024;

async function bytesFor(tenantId: number, assetId: number | null, base64: string | null): Promise<Buffer> {
  if (base64) {
    const raw = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
    if (raw.length > MAX_BASE64) throw new HttpError(413, "IMAGE_TOO_LARGE", "Ảnh quá lớn.");
    const buf = Buffer.from(raw, "base64");
    if (!buf.length) throw new HttpError(400, "INVALID_IMAGE", "Ảnh không hợp lệ.");
    return buf;
  }
  if (!assetId) throw new HttpError(400, "MISSING_IMAGE", "Cần assetId hoặc ảnh.");
  // tenant scoping: chỉ đọc ảnh của cửa hàng hiện tại
  const res = await db.execute(sql`select url, data from assets where id = ${assetId} and tenant_id = ${tenantId} limit 1`);
  const row = (res.rows?.[0] ?? null) as { url: string | null; data: string | null } | null;
  if (!row) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy ảnh trong cửa hàng này.");
  if (row.data && row.data.length > 64) return Buffer.from(row.data, "base64");
  const local = row.url ? await readLocalAsset(row.url) : null;
  if (!local) throw new HttpError(422, "ASSET_NOT_READABLE", "Không đọc được nội dung ảnh.");
  return local;
}

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

    const buffer = await bytesFor(tenantId, Number.isInteger(assetId) && assetId > 0 ? assetId : null, base64);
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
