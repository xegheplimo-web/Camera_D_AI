import { db } from "@/db";
import { events, cameras, alertRules } from "@/db/schema";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { authorize } from "@/lib/auth-server";
import { audit } from "@/lib/audit";
import { thumbMap } from "@/lib/qa";
import { ensureSeed } from "@/lib/seed";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  await ensureSeed();
  const u = new URL(req.url);
  const days = Math.min(30, Math.max(1, Number(u.searchParams.get("days") ?? 7)));
  const from = new Date(Date.now() - days * 86400000);
  const settings = await getSettings();
  const where = and(...(settings.demoMode ? [] : [sql`${events.source} <> 'demo'`]), gte(events.happenedAt, from), sql`(${events.type} = 'alert' or ${events.priority} in ('important','critical'))`);
  const rows = await db.select().from(events).where(where).orderBy(desc(events.happenedAt)).limit(100);
  const cams = await db.select().from(cameras);
  const tm = await thumbMap(rows.map((r) => r.assetId));
  const rules = await db.select().from(alertRules).orderBy(alertRules.id);
  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unacked: sql<number>`count(*) filter (where ${events.ackAt} is null)::int`,
      critical: sql<number>`count(*) filter (where ${events.priority} = 'critical')::int`,
      important: sql<number>`count(*) filter (where ${events.priority} = 'important')::int`,
    })
    .from(events)
    .where(where);
  return Response.json({
    counts,
    rules,
    items: rows.map((r) => ({
      ...r,
      thumb: r.assetId ? tm.get(r.assetId) ?? null : null,
      camera: cams.find((c) => c.id === r.cameraId)?.name ?? "",
      cameraLocation: cams.find((c) => c.id === r.cameraId)?.location ?? "",
    })),
    canManage: auth.session.role !== "viewer",
  });
}

/** Acknowledge alerts (any signed-in role) or revoke/ack an alert. */
export async function POST(req: Request) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  const b = await req.json().catch(() => null);
  const ids: number[] = Array.isArray(b?.ids) ? b.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
  if (b?.all === true) {
    await db.update(events).set({ ackAt: new Date(), ackBy: auth.session.name }).where(isNull(events.ackAt));
    await audit("alert.ack_all", { targetType: "events" });
    return Response.json({ ok: true });
  }
  if (!ids.length) return Response.json({ title: "Thiếu mã cảnh báo", status: 400 }, { status: 400 });
  await db.update(events).set({ ackAt: new Date(), ackBy: auth.session.name }).where(inArray(events.id, ids));
  await audit("alert.ack", { targetType: "event", targetId: ids.join(",") });
  return Response.json({ ok: true });
}

/** Alert rules: create/toggle/delete require manage permission. */
export async function PUT(req: Request) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  const b = await req.json().catch(() => null);
  if (b?.action === "create") {
    const name = String(b.name ?? "").trim().slice(0, 80);
    if (!name) return Response.json({ title: "Thiếu tên quy tắc", status: 400 }, { status: 400 });
    const [row] = await db
      .insert(alertRules)
      .values({
        name,
        type: ["alert", "vehicle", "person_in", "motion"].includes(b.type) ? b.type : "alert",
        priority: ["important", "critical"].includes(b.priority) ? b.priority : "important",
        cameraId: b.cameraId ? Number(b.cameraId) : null,
        cooldownSeconds: Math.min(3600, Math.max(30, Number(b.cooldownSeconds ?? 300))),
        notifyPush: Boolean(b.notifyPush),
        createdBy: auth.session.name,
      })
      .returning();
    await audit("alert_rule.create", { targetType: "alert_rule", targetId: row.id, detail: name });
    return Response.json(row, { status: 201 });
  }
  if (b?.action === "toggle" && b.id) {
    const [ex] = await db.select().from(alertRules).where(eq(alertRules.id, Number(b.id))).limit(1);
    if (!ex) return Response.json({ title: "Không tìm thấy quy tắc", status: 404 }, { status: 404 });
    const [row] = await db.update(alertRules).set({ enabled: !ex.enabled, notifyPush: typeof b.notifyPush === "boolean" ? b.notifyPush : ex.notifyPush }).where(eq(alertRules.id, ex.id)).returning();
    await audit("alert_rule.toggle", { targetType: "alert_rule", targetId: row.id, detail: String(row.enabled) });
    return Response.json(row);
  }
  if (b?.action === "delete" && b.id) {
    await db.delete(alertRules).where(eq(alertRules.id, Number(b.id)));
    await audit("alert_rule.delete", { targetType: "alert_rule", targetId: b.id });
    return Response.json({ ok: true });
  }
  return Response.json({ title: "Thao tác không hợp lệ", status: 400 }, { status: 400 });
}
