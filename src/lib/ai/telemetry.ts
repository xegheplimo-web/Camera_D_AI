import { db } from "@/db";
import { auditLog } from "@/db/schema";
import type { TaskType } from "./types";

export type ConsentState = "allowed" | "denied" | "not_required";

/**
 * One compact audit row per routed AI task. Never log prompts, images, audio,
 * raw responses or credentials — only the routing/enforcement metadata below.
 */
export type RouteRecord = {
  taskType: TaskType;
  profile?: string;
  adapter?: string;
  model?: string | null;
  latencyMs: number;
  ok: boolean;
  fallbackUsed: boolean;
  consentState: ConsentState;
  requestId?: string;
  jobId?: string;
};

export async function recordRoute(rec: RouteRecord, actor?: { name?: string; role?: string; device?: string }) {
  try {
    await db.insert(auditLog).values({
      actor: actor?.name ?? null,
      actorRole: actor?.role ?? null,
      device: actor?.device ?? null,
      action: "ai.route",
      targetType: "ai.task",
      targetId: rec.taskType,
      detail: JSON.stringify({
        taskType: rec.taskType,
        profile: rec.profile ?? null,
        adapter: rec.adapter ?? null,
        model: rec.model ?? null,
        latencyMs: Math.round(rec.latencyMs),
        ok: !!rec.ok,
        fallbackUsed: !!rec.fallbackUsed,
        consentState: rec.consentState,
        requestId: rec.requestId ?? null,
        jobId: rec.jobId ?? null,
      }),
    });
  } catch {
    // telemetry must never break the request path
  }
}
