import { db } from "@/db";
import { aiJobs, assets, cameras, events, extractions, users } from "@/db/schema";
import { and, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { audit, problem } from "@/lib/audit";
import { tenantIdOf } from "@/lib/knowledge/tenant";
import type { SessionPayload } from "@/lib/token";

/**
 * Object-level authorization — the second layer after role gating (authorize()).
 * Scope contract lives in docs/SECURITY_MAP.md:
 *   shared      camera-bound telemetry (cameras, events, alert rules, settings)
 *   user-bound  per-user objects (assets, extractions, messages, ai_jobs)
 *   private     identity/session/credential rows (never returned by resource APIs)
 * Every denial is a uniform 404 (no existence leak) and is audited as scope.denied.
 */

export type ResourceKind = "camera" | "event" | "asset" | "extraction" | "job";
export type ScopeMode = "read" | "write";
export type Scoped<T> = { ok: true; row: T } | { ok: false; response: Response };

/**
 * Tenant là biên cứng (H-01f): owner chỉ bypass phạm vi *người dùng*, không bao giờ
 * bypass phạm vi *tenant*. Caller đã resolve tenantId thì truyền vào; chưa có thì
 * fallback về subquery trên users trong cùng câu truy vấn — không cần round-trip.
 */
const sessionTenant = (session: SessionPayload): SQL =>
  sql`(select ${users.tenantId} from ${users} where ${users.id} = ${session.sub})`;

/** Assets: own uploads are private; camera-bound evidence and demo media are shared — chỉ trong tenant. */
export function assetReadScope(session: SessionPayload, tenantId?: number): SQL | undefined {
  const tenant = eq(assets.tenantId, tenantId ?? sessionTenant(session));
  if (session.role === "owner") return tenant;
  return and(tenant, or(eq(assets.userId, session.sub), isNotNull(assets.cameraId), eq(assets.origin, "demo")));
}

/** Extractions: notes belong to their author; demo rows stay visible for the demo workspace. */
export function extractionScope(session: SessionPayload, mode: ScopeMode = "read", tenantId?: number): SQL | undefined {
  const tenant = eq(extractions.tenantId, tenantId ?? sessionTenant(session));
  if (session.role === "owner") return tenant;
  return and(tenant, mode === "write" ? eq(extractions.userId, session.sub) : or(eq(extractions.userId, session.sub), eq(extractions.source, "demo")));
}

async function denied(kind: ResourceKind, id: number | string, mode: ScopeMode): Promise<Scoped<never>> {
  await audit("scope.denied", { targetType: kind, targetId: id, detail: mode });
  return { ok: false, response: problem(404, "Không tìm thấy tài nguyên trong phạm vi được phép.") };
}

export async function authorizeResource(session: SessionPayload, kind: "camera", id: number, mode?: ScopeMode): Promise<Scoped<typeof cameras.$inferSelect>>;
export async function authorizeResource(session: SessionPayload, kind: "event", id: number, mode?: ScopeMode): Promise<Scoped<typeof events.$inferSelect>>;
export async function authorizeResource(session: SessionPayload, kind: "asset", id: number, mode?: ScopeMode): Promise<Scoped<typeof assets.$inferSelect>>;
export async function authorizeResource(session: SessionPayload, kind: "extraction", id: number, mode?: ScopeMode): Promise<Scoped<typeof extractions.$inferSelect>>;
export async function authorizeResource(session: SessionPayload, kind: "job", id: string, mode?: ScopeMode): Promise<Scoped<typeof aiJobs.$inferSelect>>;
export async function authorizeResource(
  session: SessionPayload,
  kind: ResourceKind,
  id: number | string,
  mode: ScopeMode = "read"
): Promise<Scoped<unknown>> {
  const tenantId = await tenantIdOf(session);
  if (kind === "camera") {
    const [row] = await db.select().from(cameras).where(and(eq(cameras.id, Number(id)), eq(cameras.tenantId, tenantId))).limit(1);
    return row ? { ok: true, row } : denied(kind, id, mode);
  }
  if (kind === "event") {
    // Camera telemetry is workspace-shared; ownership columns on events are audit metadata.
    const [row] = await db.select().from(events).where(and(eq(events.id, Number(id)), eq(events.tenantId, tenantId))).limit(1);
    return row ? { ok: true, row } : denied(kind, id, mode);
  }
  if (kind === "asset") {
    const [row] = await db.select().from(assets).where(and(eq(assets.id, Number(id)), eq(assets.tenantId, tenantId), assetReadScope(session, tenantId))).limit(1);
    if (!row) return denied(kind, id, mode);
    // Writes never touch rows the caller does not own (owner bypass for admin cleanup).
    if (mode === "write" && session.role !== "owner" && row.userId !== session.sub) return denied(kind, id, mode);
    return { ok: true, row };
  }
  if (kind === "extraction") {
    const [row] = await db.select().from(extractions).where(and(eq(extractions.id, Number(id)), eq(extractions.tenantId, tenantId), extractionScope(session, mode, tenantId))).limit(1);
    return row ? { ok: true, row } : denied(kind, id, mode);
  }
  // kind === "job": ai_jobs.user_id is the object scope; owner may inspect the whole queue — trong tenant.
  const [row] = await db.select().from(aiJobs)
    .where(and(eq(aiJobs.id, String(id)), eq(aiJobs.tenantId, tenantId), ...(session.role === "owner" ? [] : [eq(aiJobs.userId, session.sub)]))).limit(1);
  return row ? { ok: true, row } : denied(kind, id, mode);
}
