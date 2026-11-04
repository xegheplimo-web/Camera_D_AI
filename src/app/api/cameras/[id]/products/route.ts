import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { cameraProducts, knowledgeItems } from "@/db/schema";
import { audit } from "@/lib/audit";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { asObject, denied, withTenant } from "@/lib/knowledge/http";
import { cameraInTenant } from "@/lib/knowledge/items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function paramId(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "INVALID_ID", "Mã camera không hợp lệ.");
  return id;
}

function itemIdOf(v: unknown): number {
  const id = Number(v);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "INVALID_ITEM", "itemId phải là số nguyên dương.");
  return id;
}

/**
 * GET — sản phẩm đã gắn vào CHÍNH camera này (link n-n camera_products):
 * một sản phẩm có thể dùng chung giữa nhiều camera khi chủ cửa hàng chủ động
 * gắn, nhưng mỗi camera chỉ thấy link của mình — không lọc phía client.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("read", async ({ tenantId }) => {
    const id = await cameraInTenant(tenantId, await paramId(ctx));
    const rows = await db
      .select({
        linkId: cameraProducts.id,
        itemId: knowledgeItems.id,
        title: knowledgeItems.title,
        sku: knowledgeItems.sku,
        priceVnd: knowledgeItems.priceVnd,
        note: knowledgeItems.note,
        linkedAt: cameraProducts.createdAt,
      })
      .from(cameraProducts)
      .innerJoin(knowledgeItems, eq(cameraProducts.itemId, knowledgeItems.id))
      .where(
        and(
          eq(cameraProducts.tenantId, tenantId),
          eq(cameraProducts.cameraId, id),
          eq(knowledgeItems.tenantId, tenantId),
          isNull(knowledgeItems.deletedAt),
        )
      )
      .orderBy(asc(cameraProducts.id));
    return Response.json(rows);
  });
}

/**
 * POST { itemId } — gắn sản phẩm của tenant vào camera. Idempotent qua
 * UNIQUE(camera_id, item_id): gắn lại ⇒ 200, không nhân đôi hàng, không 500.
 * Item không thuộc tenant (hoặc đã xoá mềm) ⇒ 404 — không lộ sự tồn tại.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ session, tenantId }) => {
    const id = await cameraInTenant(tenantId, await paramId(ctx));
    const itemId = itemIdOf(asObject(await readJsonBody(req)).itemId);
    const [item] = await db
      .select({ id: knowledgeItems.id })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.id, itemId), eq(knowledgeItems.tenantId, tenantId), isNull(knowledgeItems.deletedAt)))
      .limit(1);
    if (!item) return denied("knowledge_item", itemId);
    const [link] = await db
      .insert(cameraProducts)
      .values({ tenantId, cameraId: id, itemId, createdBy: session.sub })
      .onConflictDoNothing({ target: [cameraProducts.cameraId, cameraProducts.itemId] })
      .returning({ id: cameraProducts.id });
    if (link) await audit("camera.product_link", { targetType: "camera", targetId: id, detail: `item=${itemId}` });
    return Response.json({ ok: true, itemId, alreadyLinked: !link });
  });
}

/** DELETE ?itemId= — gỡ link khỏi camera này; link không tồn tại ⇒ 404. Item gốc không bị xoá. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withTenant("manage", async ({ tenantId }) => {
    const id = await cameraInTenant(tenantId, await paramId(ctx));
    const itemId = itemIdOf(new URL(req.url).searchParams.get("itemId"));
    const gone = await db
      .delete(cameraProducts)
      .where(and(eq(cameraProducts.tenantId, tenantId), eq(cameraProducts.cameraId, id), eq(cameraProducts.itemId, itemId)))
      .returning({ id: cameraProducts.id });
    if (!gone.length) throw new HttpError(404, "NOT_LINKED", "Sản phẩm chưa được gắn vào camera này.");
    await audit("camera.product_unlink", { targetType: "camera", targetId: id, detail: `item=${itemId}` });
    return Response.json({ ok: true, itemId });
  });
}
