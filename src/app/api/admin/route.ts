import { db } from "@/db";
import { auditLog, events, extractions, assets, cameras, messages, sessions, users, aiJobs } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { ensureSeed, reseed, demoSeedEnabled } from "@/lib/seed";
import { purgeDemoData, unlinkPending } from "@/lib/retention";

export const dynamic = "force-dynamic";

const DANGER_PHRASE = "XOA DU LIEU";

export async function GET() {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  await ensureSeed();
  const logs = await db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(60);
  const [d] = await db
    .select({ demo: sql<number>`count(*) filter (where ${events.source} = 'demo')::int`, live: sql<number>`count(*) filter (where ${events.source} <> 'demo')::int` })
    .from(events);
  const [st] = await db.select({ bytes: sql<number>`coalesce(sum(${assets.sizeBytes}),0)::bigint` }).from(assets);
  const [dx] = await db.select({ c: sql<number>`count(*)::int` }).from(extractions).where(eq(extractions.source, "demo"));
  const [da] = await db.select({ c: sql<number>`count(*)::int` }).from(assets).where(eq(assets.origin, "demo"));
  const activeSessions = await db
    .select({ id: sessions.id, user: users.displayName, role: users.role, device: sessions.device, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, revokedAt: sessions.revokedAt })
    .from(sessions)
    .leftJoin(users, eq(users.id, sessions.userId))
    .orderBy(desc(sessions.createdAt))
    .limit(20);
  return Response.json({
    logs,
    demoEvents: d.demo,
    liveEvents: d.live,
    demo: { events: d.demo, extractions: dx.c, assets: da.c },
    storageBytes: Number(st.bytes),
    demoSeedEnabled: demoSeedEnabled(),
    visionCloud: Boolean(process.env.OPENAI_API_KEY),
    sessions: activeSessions,
    me: { name: auth.session.name, role: auth.session.role },
  });
}

/**
 * Destructive operations: owner role + explicit typed confirmation phrase.
 * Previously this route was unauthenticated (P0 finding in the G0 audit).
 */
export async function POST(req: Request) {
  const auth = await authorize("delete");
  if (auth.response) return auth.response;
  if (auth.session.role !== "owner") {
    return Response.json({ title: "Chỉ chủ hệ thống được xóa dữ liệu", status: 403 }, { status: 403 });
  }
  const b = await req.json().catch(() => null);
  const action = b?.action;
  if (b?.confirmPhrase !== DANGER_PHRASE) {
    return Response.json({ title: "Cụm xác nhận không đúng", detail: `Nhập chính xác “${DANGER_PHRASE}”`, status: 400 }, { status: 400 });
  }
  if (action === "purge_demo") {
    // FK-safe trong purgeDemoData: extractions demo → events demo → assets origin='demo'
    // (gỡ con trỏ từ hàng live trước; asset demo còn được live extraction trỏ thì giữ).
    const report = await db.transaction(async (tx) => purgeDemoData(tx, { name: auth.session.name, role: auth.session.role, device: auth.session.device }));
    // Xoá file sau commit — rollback không được để lại hàng trỏ file đã mất.
    await unlinkPending(report.pendingFiles);
    return Response.json({ ok: true, ...report });
  }
  if (action === "clear_demo") {
    await db.delete(events).where(eq(events.source, "demo"));
    await db.delete(extractions).where(eq(extractions.source, "demo"));
    await audit("data.clear_demo", { targetType: "events" });
    return Response.json({ ok: true });
  }
  if (action === "reset_all") {
    await db.update(aiJobs).set({ state: "cancelled", errorCode: "DATA_RESET", error: "Dữ liệu đã được chủ hệ thống đặt lại.", finishedAt: new Date(), leaseUntil: null }).where(sql`${aiJobs.state} in ('queued','running')`);
    await db.delete(events);
    await db.delete(extractions);
    await db.delete(messages);
    await db.delete(assets);
    await db.delete(cameras);
    await audit("data.reset_all", { targetType: "all" });
    // demoReseeded báo UI nói thật: flag tắt → hệ thống trống, không hứa "tạo lại mẫu".
    const demoReseeded = await reseed();
    return Response.json({ ok: true, demoReseeded });
  }
  if (action === "revoke_sessions") {
    await db.update(sessions).set({ revokedAt: new Date() }).where(sql`${sessions.id} <> ${auth.session.sid}`);
    await audit("auth.revoke_other_sessions");
    return Response.json({ ok: true });
  }
  return Response.json({ title: "Thao tác không hợp lệ", status: 400 }, { status: 400 });
}
