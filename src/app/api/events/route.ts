import { db } from "@/db";
import { events, cameras, alertRules } from "@/db/schema";
import { and, desc, eq, gte, isNull, lt, ilike, or, sql, type SQL } from "drizzle-orm";
import { ensureSeed } from "@/lib/seed";
import { thumbMap } from "@/lib/qa";
import { audit, problem } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

const TYPES = ["person_in", "person_out", "vehicle", "motion", "alert", "snapshot", "manual", "clip"];

export async function GET(req: Request) {
  await ensureSeed();
  const u = new URL(req.url);
  const settings = await getSettings();
  const conds: SQL[] = [];
  const type = u.searchParams.get("type");
  const camera = u.searchParams.get("camera");
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  const q = u.searchParams.get("q");
  const tag = u.searchParams.get("tag");
  const priority = u.searchParams.get("priority");
  const objectClass = u.searchParams.get("class");
  const before = u.searchParams.get("before");
  const source = u.searchParams.get("source"); // demo | live | manual
  const ack = u.searchParams.get("ack"); // unacked | acked
  const trust = u.searchParams.get("trust"); // verified | client
  const limit = Math.min(100, Number(u.searchParams.get("limit") ?? 40));
  if (type && TYPES.includes(type)) conds.push(eq(events.type, type));
  if (camera) conds.push(eq(events.cameraId, Number(camera)));
  if (from) conds.push(gte(events.happenedAt, new Date(from)));
  if (to) conds.push(lt(events.happenedAt, new Date(to)));
  if (priority) conds.push(eq(events.priority, priority));
  if (objectClass) conds.push(eq(events.objectClass, objectClass));
  if (tag) conds.push(sql`${events.tags} @> ${JSON.stringify([tag])}::jsonb`);
  if (source) conds.push(eq(events.source, source));
  if (ack === "unacked") conds.push(isNull(events.ackAt));
  if (ack === "acked") conds.push(sql`${events.ackAt} is not null`);
  if (trust === "client") conds.push(eq(events.clientReported, true));
  if (trust === "verified") conds.push(eq(events.clientReported, false));
  // Demo data must never be presented as real camera data when demo mode is off.
  if (!settings.demoMode) conds.push(sql`${events.source} <> 'demo'`);
  if (before) conds.push(lt(events.id, Number(before)));
  if (q) {
    for (const t of q.trim().split(/\s+/).slice(0, 5)) {
      conds.push(or(ilike(events.label, `%${t}%`), ilike(events.note, `%${t}%`), sql`${events.tags}::text ilike ${"%" + t + "%"}`)!);
    }
  }
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db.select().from(events).where(where).orderBy(desc(events.happenedAt), desc(events.id)).limit(limit);
  const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(events).where(where);
  const tm = await thumbMap(rows.map((r) => r.assetId));
  const cams = await db.select().from(cameras);
  return Response.json({
    total: c,
    demoMode: settings.demoMode,
    items: rows.map((r) => {
      const cam = cams.find((x) => x.id === r.cameraId);
      return { ...r, thumb: r.assetId ? tm.get(r.assetId) ?? null : null, camera: cam ? `${cam.name} – ${cam.location}` : "" };
    }),
  });
}

export async function POST(req: Request) {
  const auth = await authorize("capture");
  if (auth.response) return auth.response;
  const b = await req.json().catch(() => null);
  if (!b) return problem(400, "Body không hợp lệ");
  const type = String(b.type ?? "manual");
  if (!TYPES.includes(type)) return problem(400, "Loại sự kiện không hợp lệ");
  const cameraId = Number(b.cameraId);
  const cam = (await db.select().from(cameras).where(eq(cameras.id, cameraId)).limit(1))[0];
  if (!cam) return problem(400, "Camera không tồn tại");

  const idem = b.idempotencyKey ? String(b.idempotencyKey).slice(0, 120) : null;
  if (idem) {
    const ex = await db.select().from(events).where(eq(events.idempotencyKey, idem)).limit(1);
    if (ex.length) return Response.json({ ...ex[0], duplicate: true });
  }

  // Browser-side detection/counts are recorded, but flagged as client-reported (untrusted evidence).
  const clientReported = ["person_in", "person_out", "vehicle", "motion", "alert"].includes(type) || b.clientReported === true;
  const confidence = typeof b.confidence === "number" ? Math.max(0, Math.min(1, b.confidence)) : null;

  // Alert rules (server-side) may escalate priority; a client cannot push its own severity for critical types.
  const rules = await db.select().from(alertRules).where(eq(alertRules.enabled, true));
  const matched = rules.find((r) => r.type === type && (!r.cameraId || r.cameraId === cameraId) && (confidence ?? 1) >= r.minConfidence);
  const requestedPriority = ["normal", "important", "critical"].includes(b.priority) ? b.priority : "normal";
  const priority = matched && !clientReported ? matched.priority : clientReported ? "normal" : requestedPriority;

  const [row] = await db
    .insert(events)
    .values({
      cameraId,
      type,
      objectClass: b.objectClass ? String(b.objectClass).slice(0, 32) : null,
      label: String(b.label ?? "Sự kiện thủ công").slice(0, 200),
      note: b.note ? String(b.note).slice(0, 2000) : null,
      trackId: b.trackId ? String(b.trackId).slice(0, 64) : null,
      confidence,
      priority,
      tags: Array.isArray(b.tags) ? b.tags.map(String).slice(0, 10) : [],
      assetId: b.assetId ? Number(b.assetId) : null,
      idempotencyKey: idem,
      source: type === "manual" || type === "snapshot" ? "manual" : "live",
      clientReported,
      createdBy: auth.session.name,
    })
    .returning();
  if (type === "manual" || type === "snapshot" || type === "clip" || clientReported) {
    await audit(`event.${type}`, { targetType: "event", targetId: row.id, detail: clientReported ? "client-reported" : row.label });
  }
  return Response.json(row, { status: 201 });
}
