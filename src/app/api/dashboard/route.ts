import { db } from "@/db";
import { events, assets, extractions, cameras } from "@/db/schema";
import { and, desc, gte, lt, sql, eq } from "drizzle-orm";
import { ensureSeed } from "@/lib/seed";
import { startOfDayVN, addDays, TZ, TZSQL } from "@/lib/time";
import { thumbMap } from "@/lib/qa";
import { getSettings } from "@/lib/settings";
import { publicCamera } from "@/lib/camera/public";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeed();
  const settings = await getSettings();
  const demoCond = settings.demoMode ? undefined : sql`${events.source} <> 'demo'`;
  const start = startOfDayVN();
  const end = addDays(start, 1);
  const inToday = and(gte(events.happenedAt, start), lt(events.happenedAt, end), eq(events.clientReported, false), ...(demoCond ? [demoCond] : []));

  const [t] = await db
    .select({
      personIn: sql<number>`count(*) filter (where ${events.type} = 'person_in')::int`,
      personOut: sql<number>`count(*) filter (where ${events.type} = 'person_out')::int`,
      vehicles: sql<number>`count(*) filter (where ${events.type} = 'vehicle')::int`,
      motorcycles: sql<number>`count(*) filter (where ${events.type} = 'vehicle' and ${events.objectClass} = 'motorcycle')::int`,
      cars: sql<number>`count(*) filter (where ${events.type} = 'vehicle' and ${events.objectClass} = 'car')::int`,
      alerts: sql<number>`count(*) filter (where ${events.type} = 'alert')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(events)
    .where(inToday);

  const hourExpr = sql<number>`extract(hour from ${events.happenedAt} at time zone ${TZSQL})::int`;
  const hourly = await db
    .select({
      h: hourExpr,
      people: sql<number>`count(*) filter (where ${events.type} = 'person_in')::int`,
      vehicles: sql<number>`count(*) filter (where ${events.type} = 'vehicle')::int`,
    })
    .from(events)
    .where(inToday)
    .groupBy(hourExpr)
    .orderBy(hourExpr);

  const [mem] = await db
    .select({
      images: sql<number>`count(*) filter (where ${assets.kind} = 'image' and ${assets.origin} <> 'demo')::int`,
      videos: sql<number>`count(*) filter (where ${assets.kind} = 'video')::int`,
    })
    .from(assets);
  const [ex] = await db
    .select({ notes: sql<number>`count(*)::int`, verified: sql<number>`count(*) filter (where ${extractions.status} = 'VERIFIED')::int` })
    .from(extractions).where(settings.demoMode ? undefined : sql`${extractions.source} <> 'demo'`);
  const [allEv] = await db.select({ c: sql<number>`count(*)::int` }).from(events).where(demoCond);
  const [store] = await db.select({ bytes: sql<number>`coalesce(sum(${assets.sizeBytes}),0)::bigint` }).from(assets);
  const [sync] = await db.select({ last: sql<Date | null>`max(${events.happenedAt})` }).from(events).where(demoCond);
  const [unacked] = await db.select({ c: sql<number>`count(*) filter (where ${events.ackAt} is null)::int` }).from(events).where(and(sql`${events.type} = 'alert'`, ...(demoCond ? [demoCond] : [])));
  const [demoShare] = await db.select({ demo: sql<number>`count(*) filter (where ${events.source} = 'demo')::int`, all: sql<number>`count(*)::int` }).from(events);

  const camRows = await db.select().from(cameras).orderBy(cameras.id);
  const fiveMin = new Date(Date.now() - 5 * 60000);
  const perCam = await db
    .select({
      cameraId: events.cameraId,
      today: sql<number>`count(*)::int`,
      recent: sql<number>`count(*) filter (where ${events.happenedAt} >= ${fiveMin.toISOString()})::int`,
    })
    .from(events)
    .where(inToday)
    .groupBy(events.cameraId);

  const recent = await db.select().from(events).where(demoCond).orderBy(desc(events.happenedAt)).limit(8);
  const tm = await thumbMap(recent.map((r) => r.assetId));
  const latestAlert = await db.select().from(events).where(and(eq(events.type, "alert"), gte(events.happenedAt, new Date(Date.now() - 3600000)), ...(demoCond ? [demoCond] : []))).limit(1);

  return Response.json({
    today: t,
    hourly,
    memory: { images: mem.images, videos: mem.videos, notes: ex.notes, verified: ex.verified, events: allEv.c },
    cameras: camRows.map((c) => ({ ...publicCamera(c), today: perCam.find((p) => p.cameraId === c.id)?.today ?? 0, recent5m: perCam.find((p) => p.cameraId === c.id)?.recent ?? 0 })),
    recent: recent.map((r) => ({ ...r, thumb: r.assetId ? tm.get(r.assetId) ?? null : null, camera: camRows.find((c) => c.id === r.cameraId)?.name ?? "" })),
    activeAlert: latestAlert.length > 0,
    uptimeSec: Math.round(process.uptime()),
    serverTime: new Date().toISOString(),
    visionCloud: Boolean(process.env.OPENAI_API_KEY),
    settings,
    storageBytes: Number(store.bytes),
    lastSyncAt: sync.last,
    unackedAlerts: unacked.c,
    demoShare: { demo: demoShare.demo, total: demoShare.all },
  });
}
