import { audit } from "@/lib/audit";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { deleteItem, getItem, updateItem } from "@/lib/knowledge/items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "INVALID_ID", "Mã mục không hợp lệ.");
  return id;
}

/** GET — item + ảnh (kèm note riêng từng ảnh) + lịch sử giá. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("read", async ({ tenantId }) => {
    const id = await paramId(ctx);
    return Response.json(await getItem(tenantId, id));
  });
}

/** PATCH — sửa title/scope/cameraId/sku/note/custom (giá chỉ đổi qua POST .../price). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ tenantId }) => {
    const id = await paramId(ctx);
    const body = await readJsonBody(req);
    const row = await updateItem(tenantId, id, body);
    await audit("knowledge_item.update", { targetType: "knowledge_item", targetId: id });
    return Response.json(row);
  });
}

/** DELETE — soft delete (deleted_at); ảnh assets gốc không bị đụng tới. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ tenantId }) => {
    const id = await paramId(ctx);
    await deleteItem(tenantId, id);
    await audit("knowledge_item.delete", { targetType: "knowledge_item", targetId: id });
    return Response.json({ ok: true, deleted: id });
  });
}
