import { withTenant } from "@/lib/knowledge/http";
import { correctionStats } from "@/lib/retail/corrections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET — SKU hay bị nhận nhầm + số lần sửa (T-1365). */
export async function GET() {
  return withTenant("read", async ({ tenantId }) => Response.json(await correctionStats(tenantId)));
}
