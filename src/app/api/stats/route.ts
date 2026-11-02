import { db } from "@/db";
import { events, cameras } from "@/db/schema";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { ensureSeed } from "@/lib/seed";
import { getSettings } from "@/lib/settings";
import { startOfDayVN, addDays, TZ, TZSQL } from "@/lib/time";
import { authorize } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  await ensureSeed();
  const days = Math.min(30, Math.max(1, Number(new URL(req.url).searchParams.get("days") ?? 7)));
  const settings = await getSettings();
  const end = addDays(startOfDayVN(), 1);
  const start = addDays(end, -days);
  const where = and(gte(events.happenedAt, start), lt(events.happenedAt, end), eq(events.clientReported, false), ...(settings.demoMode ? [] : [sql`${events.source} <> 'demo'`]));

  const [totals] = await db
    .select({
      personIn: sql<number>`count(*) filter (where ${events.type} = 'person_in')::int`,
      personOut: sql<number>`count(*) filter (where ${events.type} = 'person_out')::int`,
      vehicles: sql<number>`count(*) filter (where ${events.type} = 'vehicle')::int`,
      alerts: sql<number>`count(*) filter (where ${events.type} = 'alert')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(events)
    .where(where);

  const dayExpr = sql<string>`to_char(${events.happenedAt} at time zone ${TZSQL}, 'YYYY-MM-DD')`;
  const daily = await db
    .select({
      day: dayExpr,
      personIn: sql<number>`count(*) filter (where ${events.type} = 'person_in')::int`,
      personOut: sql<number>`count(*) filter (where ${events.type} = 'person_out')::int`,
      vehicles: sql<number>`count(*) filter (where ${events.type} = 'vehicle')::int`,
    })
    .from(events)
    .where(where)
    .groupBy(dayExpr)
    .orderBy(dayExpr);

  const dowExpr = sql<number>`extract(isodow from ${events.happenedAt} at time zone ${TZSQL})::int`;
  const hourExpr = sql<number>`extract(hour from ${events.happenedAt} at time zone ${TZSQL})::int`;
  const heat = await db
    .select({ dow: dowExpr, h: hourExpr, c: sql<number>`count(*)::int` })
    .from(events)
    .where(and(where, sql`${events.type} = 'person_in'`))
    .groupBy(dowExpr, hourExpr);

  const byCamera = await db
    .select({ cameraId: events.cameraId, c: sql<number>`count(*)::int`, demo: sql<number>`count(*) filter (where ${events.source} = 'demo')::int` })
    .from(events)
    .where(where)
    .groupBy(events.cameraId);
  const cams = await db.select().from(cameras);

  const byType = await db
    .select({ type: events.type, c: sql<number>`count(*)::int` })
    .from(events)
    .where(where)
    .groupBy(events.type);

  // fill missing days
  const filled = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    const key = new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);
    filled.push(daily.find((x) => x.day === key) ?? { day: key, personIn: 0, personOut: 0, vehicles: 0 });
  }

  const [share] = await db
    .select({ demo: sql<number>`count(*) filter (where ${events.source} = 'demo')::int`, all: sql<number>`count(*)::int` })
    .from(events)
    .where(where);
  const [cov] = await db
    .select({ hours: sql<number>`count(distinct date_trunc('hour', ${events.happenedAt} at time zone ${TZSQL}))::int` })
    .from(events)
    .where(where);

  return Response.json({
    meta: { timezone: TZ, demoShare: share.all ? share.demo / share.all : 0, total: share.all, hoursCovered: cov.hours, demoMode: settings.demoMode },
    range: { start, end, days },
    totals,
    daily: filled,
    heat,
    byCamera: byCamera
      .map((b) => {
        const c = cams.find((x) => x.id === b.cameraId);
        return { cameraId: b.cameraId, name: c ? `${c.name} – ${c.location}` : `#${b.cameraId}`, c: b.c, demo: b.demo };
      })
      .sort((a, b) => b.c - a.c),
    byType: byType.sort((a, b) => b.c - a.c),
  });
}
