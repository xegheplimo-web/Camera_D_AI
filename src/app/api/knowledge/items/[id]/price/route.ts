import { audit } from "@/lib/audit";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { setPrice } from "@/lib/knowledge/items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST — đổi giá chuẩn {priceVnd} (integer VND, không âm): insert history +
 * update items.price_vnd trong cùng transaction, trả mục đã cập nhật.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ session, tenantId }) => {
    const id = Number((await ctx.params).id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "INVALID_ID", "Mã mục không hợp lệ.");
    const body = await readJsonBody(req);
    const item = await setPrice(tenantId, session, id, body);
    await audit("knowledge_price.set", { targetType: "knowledge_item", targetId: id, detail: `price_vnd=${item.priceVnd}` });
    return Response.json(item);
  });
}
