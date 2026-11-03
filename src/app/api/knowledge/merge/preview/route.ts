import { HttpError } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { previewMerge } from "@/lib/knowledge/merge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET — xem trước khi gộp (T-1355). Chỉ đọc, không ghi.
 * Trả PRICE_REVIEW_REQUIRED kèm hai giá khi không tự quyết được.
 */
export async function GET(req: Request) {
  return withTenant("read", async ({ tenantId }) => {
    const url = new URL(req.url);
    const sourceId = Number(url.searchParams.get("sourceId"));
    const targetId = Number(url.searchParams.get("targetId"));
    if (!Number.isInteger(sourceId) || !Number.isInteger(targetId) || sourceId <= 0 || targetId <= 0)
      throw new HttpError(400, "INVALID_IDS", "sourceId và targetId phải là số nguyên dương.");

    return Response.json(await previewMerge(tenantId, sourceId, targetId));
  });
}
