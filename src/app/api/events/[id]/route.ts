import { db } from "@/db";
import { events } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { audit, problem } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { authorizeResource } from "@/lib/scope";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("verify");
  if (auth.response) return auth.response;
  const { id } = await ctx.params;
  const b = await req.json().catch(() => null);
  if (!b) return problem(400, "Body không hợp lệ");
  const patch: Partial<typeof events.$inferInsert> = {};
  if (["normal", "important", "critical"].includes(b.priority)) patch.priority = b.priority;
  if (Array.isArray(b.tags)) patch.tags = b.tags.map(String).slice(0, 10);
  if (typeof b.note === "string") patch.note = b.note.slice(0, 2000);
  if (typeof b.label === "string" && b.label.trim()) patch.label = b.label.slice(0, 200);
  // Human review promotes a client-reported detection to reviewed evidence.
  if (b.reviewed === true) patch.clientReported = false;
  if (!Object.keys(patch).length) return problem(400, "Không có thay đổi");
  const scoped = await authorizeResource(auth.session, "event", Number(id), "write");
  if (!scoped.ok) return scoped.response;
  const [row] = await db.update(events).set(patch).where(and(eq(events.id, scoped.row.id), eq(events.tenantId, scoped.row.tenantId))).returning();
  if (!row) return problem(404, "Không tìm thấy sự kiện");
  await audit("event.update", { targetType: "event", targetId: id, detail: JSON.stringify(patch).slice(0, 250) });
  return Response.json(row);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorize("delete");
  if (auth.response) return auth.response;
  const { id } = await ctx.params;
  const u = new URL(req.url);
  if (u.searchParams.get("confirm") !== "yes") return problem(400, "Cần xác nhận xóa", "Thêm ?confirm=yes");
  const scoped = await authorizeResource(auth.session, "event", Number(id), "write");
  if (!scoped.ok) return scoped.response;
  await db.delete(events).where(and(eq(events.id, scoped.row.id), eq(events.tenantId, scoped.row.tenantId)));
  await audit("event.delete", { targetType: "event", targetId: id });
  return Response.json({ ok: true });
}
