import { withTenant } from "@/lib/knowledge/http";
import { cameraInTenant } from "@/lib/knowledge/items";
import { findDuplicatePairs } from "@/lib/knowledge/pairs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET — liệt kê cặp trùng để UI "Rà soát trùng" (T-1351/T-1356). Chỉ đọc. */
export async function GET(req: Request) {
  return withTenant("read", async ({ tenantId }) => {
    const url = new URL(req.url);
    const raw = url.searchParams.get("cameraId");
    const cameraId = raw === null ? null : await cameraInTenant(tenantId, raw);
    return Response.json(await findDuplicatePairs(tenantId, { cameraId }));
  });
}
