import { withTenant } from "@/lib/knowledge/http";
import { encoderStatus } from "@/lib/retail/encoder";
import { indexStats } from "@/lib/retail/embedding-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET — tình trạng chỉ mục ảnh của cửa hàng + model đang dùng (T-1361). */
export async function GET() {
  return withTenant("read", async ({ tenantId }) => {
    const [encoder, index] = await Promise.all([encoderStatus(), indexStats(tenantId)]);
    return Response.json({
      encoder: { available: encoder.available, model: encoder.model, version: encoder.version, dim: encoder.dim, loadMs: encoder.loadMs, error: encoder.error },
      index: { vectors: index.vectors, items: index.items, dim: index.dim, bytes: index.bytes },
    });
  });
}
