import { db } from "@/db";
import { extractions, events, assets, cameras, aiJobs, type ExtractionResult } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { authorizeResource } from "@/lib/scope";
import { AiError } from "@/lib/ai/types";
import { aiProblem, readJson } from "@/lib/ai/http";
import { normalizeExtraction } from "@/lib/ai/vision-worker";
import { parseProductMeta } from "@/lib/product";

export const dynamic = "force-dynamic";
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("verify");
  if (auth.response) return auth.response;
  try {
    const { id } = await ctx.params;
    const body = await readJson(req, 100 * 1024);
    const row = await db.transaction(async (tx) => {
      const [cur] = await tx.select().from(extractions).where(eq(extractions.id, Number(id))).for("update").limit(1);
      if (!cur) throw new AiError("NOT_FOUND", "Không tìm thấy trích xuất.", 404);
      const scoped = await authorizeResource(auth.session, "extraction", cur.id, "write");
      if (!scoped.ok) throw new AiError("NOT_FOUND", "Không tìm thấy trích xuất trong phạm vi được phép.", 404);
      if (cur.status === "PROCESSING") throw new AiError("STILL_PROCESSING", "Tác vụ còn đang xử lý. Hãy hủy hoặc chờ xử lý AI hoàn tất.", 409);
      if (body.action === "verify" && !cur.rawResult) throw new AiError("NO_AI_EVIDENCE", "Chưa có kết quả AI để xác minh. Ghi chú nháp không phải bằng chứng trích xuất.", 409);
      const patch: Partial<typeof extractions.$inferInsert> = { updatedAt: new Date(), version: cur.version + 1 };
      if (body.result && typeof body.result === "object" && !Array.isArray(body.result)) {
        const normalized = normalizeExtraction(body.result as Record<string, unknown>, "review");
        const original = cur.rawResult;
        normalized.engine = cur.result?.engine ?? [];
        normalized.objects = normalized.objects.map((o, i) => ({ ...o, edited: original?.objects[i]?.label !== o.label || original?.objects[i]?.count !== o.count }));
        normalized.structured = normalized.structured.map((v, i) => ({ ...v, edited: original?.structured[i]?.key !== v.key || original?.structured[i]?.value !== v.value }));
        normalized.warnings = [...new Set(normalized.warnings)];
        patch.result = normalized;
      }
      if (body.productName !== undefined || body.sku !== undefined || body.priceVnd !== undefined || body.quantity !== undefined) {
        let meta;
        try { meta = parseProductMeta({
          productName: body.productName !== undefined ? body.productName : cur.productName,
          sku: body.sku !== undefined ? body.sku : cur.sku,
          priceVnd: body.priceVnd !== undefined ? body.priceVnd : cur.priceVnd,
          quantity: body.quantity !== undefined ? body.quantity : cur.quantity,
        }); }
        catch (error) { throw new AiError("INVALID_PRODUCT", error instanceof Error ? error.message : "Thông tin sản phẩm không hợp lệ.", 400); }
        Object.assign(patch, meta);
      }
      if (Array.isArray(body.tags)) patch.tags = body.tags.filter((t): t is string => typeof t === "string").slice(0, 10).map((t) => t.slice(0, 40));
      if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.slice(0, 120);
      if (body.action === "verify") { patch.status = "VERIFIED"; patch.memoryType = "verified"; patch.verifiedAt = new Date(); patch.verifiedBy = auth.session.name; }
      else if (body.action === "temporary") { patch.status = "REVIEW_REQUIRED"; patch.memoryType = "temporary"; patch.verifiedAt = null; patch.verifiedBy = null; }
      else if (body.action === "reject") { patch.status = "FAILED"; patch.verifiedAt = null; patch.verifiedBy = null; }
      if (body.attachEvent === true && !cur.eventId) {
        const [asset] = await tx.select().from(assets).where(eq(assets.id, cur.assetId)).limit(1);
        const [cam] = asset?.cameraId ? [{ id: asset.cameraId }] : await tx.select({ id: cameras.id }).from(cameras).orderBy(cameras.id).limit(1);
        if (cam) {
          const [event] = await tx.insert(events).values({ cameraId: cam.id, type: "manual", label: `Ghi chú trích xuất: ${patch.title ?? cur.title}`,
            note: (patch.result ?? cur.result)?.summary ?? cur.note, assetId: cur.assetId,
            tags: ["trích xuất", ...((patch.tags as string[]) ?? cur.tags)].slice(0, 10), priority: "important", source: cur.source === "demo" ? "demo" : "manual", createdBy: auth.session.name }).returning();
          patch.eventId = event.id;
        }
      }
      const [updated] = await tx.update(extractions).set(patch).where(eq(extractions.id, cur.id)).returning();
      return updated;
    });
    await audit(`extraction.${String(body.action ?? "edit")}`, { targetType: "extraction", targetId: id, detail: `v${row.version}` });
    return Response.json(row);
  } catch (e) { return aiProblem(e); }
}
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("delete");
  if (auth.response) return auth.response;
  const { id } = await ctx.params;
  if (new URL(req.url).searchParams.get("confirm") !== "yes") return aiProblem(new AiError("CONFIRM_REQUIRED", "Cần xác nhận xóa.", 400));
  const scoped = await authorizeResource(auth.session, "extraction", Number(id), "write");
  if (!scoped.ok) return scoped.response;
  await db.transaction(async (tx) => {
    await tx.update(aiJobs).set({ state: "cancelled", finishedAt: new Date(), errorCode: "SOURCE_DELETED", error: "Kết quả trích xuất đã bị xóa." })
      .where(and(sql`${aiJobs.input}->>'extractionId' = ${id}`, sql`${aiJobs.state} in ('queued','running')`));
    await tx.delete(extractions).where(eq(extractions.id, Number(id)));
  });
  await audit("extraction.delete", { targetType: "extraction", targetId: id });
  return Response.json({ ok: true });
}
