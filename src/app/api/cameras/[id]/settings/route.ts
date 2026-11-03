import { audit } from "@/lib/audit";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { patchCameraSettings, requireCameraSettings, settingsView } from "@/lib/knowledge/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "INVALID_ID", "Mã camera không hợp lệ.");
  return id;
}

/** GET — bộ cài đặt riêng của camera (lazy-create mặc định nếu chưa có) + capabilities do server tính. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("read", async ({ tenantId }) => {
    const id = await paramId(ctx);
    const row = await requireCameraSettings(tenantId, id);
    return Response.json(settingsView(row));
  });
}

/**
 * PATCH — sửa settings có optimistic lock: body bắt buộc `revision` khớp bản hiện
 * tại; lệch ⇒ 409 kèm {currentRevision, settings} để client merge lại.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ tenantId }) => {
    const id = await paramId(ctx);
    const body = await readJsonBody(req);
    const r = await patchCameraSettings(tenantId, id, body);
    if (!r.ok) return Response.json({ currentRevision: r.row.revision, settings: settingsView(r.row) }, { status: 409 });
    await audit("camera_settings.update", { targetType: "camera", targetId: id, detail: `rev=${r.row.revision}` });
    return Response.json(settingsView(r.row));
  });
}
