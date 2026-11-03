import { audit } from "@/lib/audit";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { deleteImage, updateImage } from "@/lib/knowledge/items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "INVALID_ID", "Mã ảnh không hợp lệ.");
  return id;
}

/** PATCH — sửa ghi chú/position của ảnh đã gắn {note?, position?}. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ tenantId }) => {
    const id = await paramId(ctx);
    const body = await readJsonBody(req);
    const row = await updateImage(tenantId, id, body);
    await audit("knowledge_image.update", { targetType: "knowledge_image", targetId: id });
    return Response.json(row);
  });
}

/** DELETE — soft delete liên kết ảnh (deleted_at); asset gốc giữ nguyên. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ tenantId }) => {
    const id = await paramId(ctx);
    await deleteImage(tenantId, id);
    await audit("knowledge_image.detach", { targetType: "knowledge_image", targetId: id });
    return Response.json({ ok: true, deleted: id });
  });
}
