import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { fail } from "@/lib/knowledge/http";
import { tenantIdOf } from "@/lib/knowledge/tenant";
import { setPrice } from "@/lib/knowledge/items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST — đổi giá chuẩn {priceVnd} (integer VND, không âm): insert history +
 * update items.price_vnd trong cùng transaction, trả mục đã cập nhật.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  try {
    const id = Number((await ctx.params).id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "INVALID_ID", "Mã mục không hợp lệ.");
    const body = await readJsonBody(req);
    const tenantId = await tenantIdOf(auth.session);
    const item = await setPrice(tenantId, auth.session, id, body);
    await audit("knowledge_price.set", { targetType: "knowledge_item", targetId: id, detail: `price_vnd=${item.priceVnd}` });
    return Response.json(item);
  } catch (e) { return fail(e); }
}
