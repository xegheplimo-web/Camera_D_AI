import { db } from "@/db";
import { cameras } from "@/db/schema";
import { ensureSeed } from "@/lib/seed";
import { authorize } from "@/lib/auth-server";
import { effectiveStatus, sourceKind, type SourceKind } from "@/lib/camera/health";
import type { ConnectionState } from "@/lib/camera/status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CamHealth = { connection: ConnectionState; sourceKind: SourceKind; checkedAt: string };

/**
 * GET /api/cameras/health — trạng thái kết nối THẬT của từng camera (T-1319).
 * Trả { [id]: { connection, sourceKind, checkedAt } }; không serialize credential,
 * không thay đổi /api/dashboard. Webcam/demo không có kết nối server-side →
 * connection "unknown" (webcam thật do trình duyệt quyết, demo là mô phỏng).
 */
export async function GET() {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  await ensureSeed();
  const rows = await db.select().from(cameras).orderBy(cameras.id);
  const checkedAt = new Date().toISOString();
  const entries = await Promise.all(
    rows.map(async (c) => {
      const eff = await effectiveStatus(c);
      const connection: ConnectionState = eff === "client" || eff === "simulated" ? "unknown" : eff;
      return [c.id, { connection, sourceKind: sourceKind(c.sourceType), checkedAt }] as const;
    })
  );
  return Response.json(Object.fromEntries(entries) as Record<number, CamHealth>, { headers: { "Cache-Control": "no-store" } });
}
