import { HttpError, readJsonBody } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { mergeItems } from "@/lib/knowledge/merge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST — gộp sản phẩm nguồn vào đích (T-1355).
 * Hai giá khác nhau mà thiếu `priceChoice` ⇒ 409 PRICE_REVIEW_REQUIRED (không tự chọn).
 */
export async function POST(req: Request) {
  return withTenant("manage", async ({ tenantId, session }) => {
    const body = await readJsonBody(req);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new HttpError(400, "INVALID_BODY", "Body phải là object JSON.");

    const b = body as Record<string, unknown>;
    const sourceId = Number(b.sourceId);
    const targetId = Number(b.targetId);
    if (!Number.isInteger(sourceId) || !Number.isInteger(targetId) || sourceId <= 0 || targetId <= 0)
      throw new HttpError(400, "INVALID_IDS", "sourceId và targetId phải là số nguyên dương.");

    const priceChoice = b.priceChoice === "source" || b.priceChoice === "target" ? b.priceChoice : undefined;
    if (b.priceChoice !== undefined && priceChoice === undefined)
      throw new HttpError(400, "INVALID_PRICE_CHOICE", "priceChoice chỉ nhận 'source' hoặc 'target'.");

    const result = await mergeItems({ tenantId, sourceId, targetId, actor: session.sub, priceChoice });
    return Response.json({ ok: true, ...result });
  });
}
