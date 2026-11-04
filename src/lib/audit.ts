import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { currentSession } from "./auth-server";
import { tenantIdOf } from "@/lib/knowledge/tenant";

export type AuditMeta = {
  targetType?: string;
  targetId?: string | number | null;
  detail?: string;
  tenantId?: number | null;
  actor?: string | null;
  actorRole?: string | null;
};

/** Audit identity comes from the verified session, never from the request body —
 *  unless the caller supplies an explicit server-side identity (e.g. login,
 *  where the session cookie is only set after the audit row is written). */
export async function audit(action: string, meta: AuditMeta = {}) {
  try {
    const s = await currentSession();
    const tenantId = meta.tenantId !== undefined ? meta.tenantId : s ? await tenantIdOf(s).catch(() => null) : null;
    await db.insert(auditLog).values({
      tenantId,
      actor: meta.actor !== undefined ? meta.actor : s?.name ?? null,
      actorRole: meta.actorRole !== undefined ? meta.actorRole : s?.role ?? null,
      action,
      targetType: meta.targetType ?? null,
      targetId: meta.targetId != null ? String(meta.targetId) : null,
      device: s?.device ?? null,
      detail: meta.detail?.slice(0, 500) ?? null,
    });
  } catch {
    // auditing must never break the main flow
  }
}

export function problem(status: number, title: string, detail?: string) {
  return new Response(JSON.stringify({ type: "about:blank", title, status, detail }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}
