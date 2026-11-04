import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { cameras } from "@/db/schema";
import { audit } from "@/lib/audit";
import { readJsonBody } from "@/lib/http-guard";
import { asObject, withTenant } from "@/lib/knowledge/http";
import { loadWallLayout, saveWallLayout } from "@/lib/wall/store";
import { WALL_MAX } from "@/lib/wall/layout";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WALL_DEFAULT = Math.min(8, WALL_MAX);

/**
 * P3 — layout tường camera, scope (tenant, user) qua key app_settings
 * `wall:tenant:<tenantId>:user:<userId>`. GET/PUT chỉ đụng key của chính
 * phiên đang đăng nhập ⇒ không bao giờ lộ/ghi layout của tenant hay user khác.
 */
export async function GET() {
  return withTenant("read", async ({ session, tenantId }) => {
    const rows = await db
      .select({ id: cameras.id, enabled: cameras.enabled })
      .from(cameras)
      .where(eq(cameras.tenantId, tenantId))
      .orderBy(asc(cameras.id));
    const ids = rows.map((r) => r.id);
    const stored = await loadWallLayout(tenantId, session.sub, ids);
    // Chưa lưu ⇒ default N camera enabled đầu tiên của tenant.
    const tiles =
      stored ??
      rows
        .filter((r) => r.enabled)
        .slice(0, WALL_DEFAULT)
        .map((r, i) => ({ cameraId: r.id, order: i }));
    return Response.json({ tiles }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function PUT(req: Request) {
  return withTenant("read", async ({ session, tenantId }) => {
    const body = asObject(await readJsonBody(req));
    const rows = await db.select({ id: cameras.id }).from(cameras).where(eq(cameras.tenantId, tenantId)).orderBy(asc(cameras.id));
    const tiles = await saveWallLayout(tenantId, session.sub, body.tiles, rows.map((r) => r.id));
    await audit("wall.layout_save", { targetType: "wall", targetId: session.sub, detail: `${tiles.length} tiles`, tenantId });
    return Response.json({ tiles }, { headers: { "Cache-Control": "no-store" } });
  });
}
