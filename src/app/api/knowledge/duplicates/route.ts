import { HttpError, readJsonBody } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { cameraInTenant } from "@/lib/knowledge/items";
import { findCandidates } from "@/lib/knowledge/duplicates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST — tìm ứng viên trùng cho một draft sản phẩm (T-1350A).
 * Chỉ đọc: không tạo/sửa/gộp bản ghi nào.
 */
export async function POST(req: Request) {
  return withTenant("read", async ({ tenantId }) => {
    const body = await readJsonBody(req);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new HttpError(400, "INVALID_BODY", "Body phải là object JSON.");

    const draft = body as Record<string, unknown>;
    const title = typeof draft.title === "string" ? draft.title.trim() : "";
    if (!title) throw new HttpError(400, "INVALID_TITLE", "title bắt buộc để tìm ứng viên trùng.");

    const cameraId =
      draft.cameraId === undefined || draft.cameraId === null ? null : await cameraInTenant(tenantId, draft.cameraId);

    return Response.json(await findCandidates(tenantId, draft, { cameraId }));
  });
}
