import { db } from "@/db";
import { auditLog, events, extractions, assets, cameras, messages, sessions, users, aiJobs } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { ensureSeed, reseed, demoSeedEnabled } from "@/lib/seed";
import { unlinkPending, type PurgeReport } from "@/lib/retention";
import { tenantIdOf } from "@/lib/knowledge/tenant";

export const dynamic = "force-dynamic";

const DANGER_PHRASE = "XOA DU LIEU";

export async function GET() {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  await ensureSeed();
  // Tenant resolve phía server từ users.tenant_id (T-1333) — client không tự khai báo.
  const tenantId = await tenantIdOf(auth.session);
  // audit_log không có cột tenant_id: chỉ trả entry do user của tenant này tạo
  // (actor = displayName). Fail-closed — hàng không quy được tenant (vd actor
  // 'system' của retention) bị ẩn khỏi mọi tenant.
  const logs = await db
    .select()
    .from(auditLog)
    .where(sql`${auditLog.actor} in (select ${users.displayName} from ${users} where ${users.tenantId} = ${tenantId})`)
    .orderBy(desc(auditLog.id))
    .limit(60);
  const [d] = await db
    .select({ demo: sql<number>`count(*) filter (where ${events.source} = 'demo')::int`, live: sql<number>`count(*) filter (where ${events.source} <> 'demo')::int` })
    .from(events)
    .where(eq(events.tenantId, tenantId));
  const [st] = await db.select({ bytes: sql<number>`coalesce(sum(${assets.sizeBytes}),0)::bigint` }).from(assets).where(eq(assets.tenantId, tenantId));
  const [dx] = await db.select({ c: sql<number>`count(*)::int` }).from(extractions).where(and(eq(extractions.source, "demo"), eq(extractions.tenantId, tenantId)));
  const [da] = await db.select({ c: sql<number>`count(*)::int` }).from(assets).where(and(eq(assets.origin, "demo"), eq(assets.tenantId, tenantId)));
  const activeSessions = await db
    .select({ id: sessions.id, user: users.displayName, role: users.role, device: sessions.device, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, revokedAt: sessions.revokedAt })
    .from(sessions)
    .leftJoin(users, eq(users.id, sessions.userId))
    .where(eq(users.tenantId, tenantId))
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
  const tenantId = await tenantIdOf(auth.session);
  if (action === "purge_demo") {
    // Bản tenant-scoped của purgeDemoData (retention.ts thao tác toàn cục và nằm
    // ngoài phạm vi sửa): cùng thứ tự FK an toàn extractions → events → assets,
    // cùng guard asset được live extraction / knowledge_images giữ.
    const report = await db.transaction(async (tx) => {
      const delEx = await tx.delete(extractions).where(and(eq(extractions.source, "demo"), eq(extractions.tenantId, tenantId))).returning({ id: extractions.id });
      const delEv = await tx.delete(events).where(and(eq(events.source, "demo"), eq(events.tenantId, tenantId))).returning({ id: events.id });
      await tx.execute(sql`update events set asset_id = null
        where asset_id is not null and asset_id in (select id from assets where origin = 'demo' and tenant_id = ${tenantId})`);
      const [tot] = await tx.select({ c: sql<number>`count(*)::int` }).from(assets).where(and(eq(assets.origin, "demo"), eq(assets.tenantId, tenantId)));
      const [keptKn] = await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(assets)
        .where(and(eq(assets.origin, "demo"), eq(assets.tenantId, tenantId), sql`not (${assets.id} in (select asset_id from extractions where asset_id is not null))`, sql`${assets.id} in (select asset_id from knowledge_images where asset_id is not null)`));
      const demoAssets = await tx
        .select({ id: assets.id, url: assets.url, sizeBytes: assets.sizeBytes })
        .from(assets)
        .where(and(eq(assets.origin, "demo"), eq(assets.tenantId, tenantId), sql`not (${assets.id} in (select asset_id from extractions where asset_id is not null))`, sql`not (${assets.id} in (select asset_id from knowledge_images where asset_id is not null))`));
      let bytes = 0;
      const pendingFiles: string[] = [];
      for (const a of demoAssets) {
        bytes += a.sizeBytes ?? 0;
        if (a.url) pendingFiles.push(a.url); // xoá sau commit, xem unlinkPending()
      }
      if (demoAssets.length) await tx.delete(assets).where(inArray(assets.id, demoAssets.map((a) => a.id)));
      const report: PurgeReport = { extractions: delEx.length, events: delEv.length, assets: demoAssets.length, assetsKept: tot.c - demoAssets.length, assetsKeptByKnowledge: keptKn.c, bytes, pendingFiles };
      await tx.insert(auditLog).values({
        actor: auth.session.name,
        actorRole: auth.session.role,
        device: auth.session.device,
        action: "data.purge_demo",
        targetType: "events|extractions|assets",
        detail: `tenant=${tenantId} events=${report.events} extractions=${report.extractions} assets=${report.assets} kept=${report.assetsKept} keptKnowledge=${report.assetsKeptByKnowledge} bytes=${report.bytes}`,
      });
      return report;
    });
    // Xoá file sau commit — rollback không được để lại hàng trỏ file đã mất.
    await unlinkPending(report.pendingFiles);
    return Response.json({ ok: true, ...report });
  }
  if (action === "clear_demo") {
    await db.delete(events).where(and(eq(events.source, "demo"), eq(events.tenantId, tenantId)));
    await db.delete(extractions).where(and(eq(extractions.source, "demo"), eq(extractions.tenantId, tenantId)));
    await audit("data.clear_demo", { targetType: "events", detail: `tenant=${tenantId}` });
    return Response.json({ ok: true });
  }
  if (action === "reset_all") {
    await db.update(aiJobs).set({ state: "cancelled", errorCode: "DATA_RESET", error: "Dữ liệu đã được chủ hệ thống đặt lại.", finishedAt: new Date(), leaseUntil: null }).where(and(eq(aiJobs.tenantId, tenantId), sql`${aiJobs.state} in ('queued','running')`));
    await db.delete(events).where(eq(events.tenantId, tenantId));
    await db.delete(extractions).where(eq(extractions.tenantId, tenantId));
    await db.delete(messages).where(eq(messages.tenantId, tenantId));
    await db.delete(assets).where(eq(assets.tenantId, tenantId));
    await db.delete(cameras).where(eq(cameras.tenantId, tenantId));
    await audit("data.reset_all", { targetType: "all", detail: `tenant=${tenantId}` });
    // reseed() ghi topology demo vào tenant mặc định + xoá marker app_settings toàn cục;
    // chỉ tenant 1 mới được gọi — tenant khác reset xong thì trống thật.
    const demoReseeded = tenantId === 1 ? await reseed() : false;
    return Response.json({ ok: true, demoReseeded });
  }
  if (action === "revoke_sessions") {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(sql`${sessions.id} <> ${auth.session.sid}`, sql`${sessions.userId} in (select ${users.id} from ${users} where ${users.tenantId} = ${tenantId})`));
    await audit("auth.revoke_other_sessions", { detail: `tenant=${tenantId}` });
    return Response.json({ ok: true });
  }
  return Response.json({ title: "Thao tác không hợp lệ", status: 400 }, { status: 400 });
}
