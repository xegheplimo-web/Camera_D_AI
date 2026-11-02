import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { currentSession } from "./auth-server";

/** Audit identity always comes from the verified session, never from the request body. */
export async function audit(action: string, meta: { targetType?: string; targetId?: string | number | null; detail?: string } = {}) {
  try {
    const s = await currentSession();
    await db.insert(auditLog).values({
      actor: s?.name ?? null,
      actorRole: s?.role ?? null,
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
