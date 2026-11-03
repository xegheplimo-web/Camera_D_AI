import { HttpError } from "@/lib/http-guard";
import { queryCameraId, withTenant } from "@/lib/knowledge/http";
import { searchKnowledge } from "@/lib/knowledge/search";

export const dynamic = "force-dynamic";

/** GET — tìm trong knowledge_items + extractions của asset thuộc scope tenant. ?q=&cameraId?=&limit? */
export async function GET(req: Request) {
  return withTenant("read", async ({ session, tenantId }) => {
    const u = new URL(req.url);
    const q = u.searchParams.get("q")?.trim() ?? "";
    const cameraId = queryCameraId(u);
    const limitParam = u.searchParams.get("limit");
    let limit = 20;
    if (limitParam !== null) {
      limit = Number(limitParam);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new HttpError(400, "INVALID_LIMIT", "limit phải là số nguyên trong khoảng 1–100.");
    }
    return Response.json(await searchKnowledge(tenantId, session, { q, cameraId, limit }));
  });
}
