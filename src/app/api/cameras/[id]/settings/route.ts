import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { fail } from "@/lib/knowledge/http";
import { tenantIdOf } from "@/lib/knowledge/tenant";
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
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  try {
    const id = await paramId(ctx);
    const tenantId = await tenantIdOf(auth.session);
    const row = await requireCameraSettings(tenantId, id);
    return Response.json(settingsView(row));
  } catch (e) { return fail(e); }
}

/**
 * PATCH — sửa settings có optimistic lock: body bắt buộc `revision` khớp bản hiện
 * tại; lệch ⇒ 409 kèm {currentRevision, settings} để client merge lại.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  try {
    const id = await paramId(ctx);
    const body = await readJsonBody(req);
    const tenantId = await tenantIdOf(auth.session);
    const r = await patchCameraSettings(tenantId, id, body);
    if (!r.ok) return Response.json({ currentRevision: r.row.revision, settings: settingsView(r.row) }, { status: 409 });
    await audit("camera_settings.update", { targetType: "camera", targetId: id, detail: `rev=${r.row.revision}` });
    return Response.json(settingsView(r.row));
  } catch (e) { return fail(e); }
}
