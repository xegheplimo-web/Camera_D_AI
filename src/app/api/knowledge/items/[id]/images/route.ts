import { audit } from "@/lib/audit";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { attachImage } from "@/lib/knowledge/items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST — gắn ảnh vào mục {assetId, note?, position?}; mỗi ảnh một ghi chú riêng. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ session, tenantId }) => {
    const itemId = Number((await ctx.params).id);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) throw new HttpError(400, "INVALID_ID", "Mã mục không hợp lệ.");
    const body = await readJsonBody(req);
    const row = await attachImage(tenantId, session, itemId, body);
    await audit("knowledge_image.attach", { targetType: "knowledge_item", targetId: itemId, detail: `asset=${row.assetId}` });
    return Response.json(row, { status: 201 });
  });
}
