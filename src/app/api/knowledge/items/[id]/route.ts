import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { fail } from "@/lib/knowledge/http";
import { tenantIdOf } from "@/lib/knowledge/tenant";
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
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  try {
    const id = await paramId(ctx);
    const tenantId = await tenantIdOf(auth.session);
    return Response.json(await getItem(tenantId, id));
  } catch (e) { return fail(e); }
}

/** PATCH — sửa title/scope/cameraId/sku/note/custom (giá chỉ đổi qua POST .../price). */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  try {
    const id = await paramId(ctx);
    const body = await readJsonBody(req);
    const tenantId = await tenantIdOf(auth.session);
    const row = await updateItem(tenantId, id, body);
    await audit("knowledge_item.update", { targetType: "knowledge_item", targetId: id });
    return Response.json(row);
  } catch (e) { return fail(e); }
}

/** DELETE — soft delete (deleted_at); ảnh assets gốc không bị đụng tới. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  try {
    const id = await paramId(ctx);
    const tenantId = await tenantIdOf(auth.session);
    await deleteItem(tenantId, id);
    await audit("knowledge_item.delete", { targetType: "knowledge_item", targetId: id });
    return Response.json({ ok: true, deleted: id });
  } catch (e) { return fail(e); }
}
