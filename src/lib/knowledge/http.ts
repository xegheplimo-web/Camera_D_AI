import { audit, problem } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { HttpError } from "@/lib/http-guard";
import type { SessionPayload } from "@/lib/token";
import { tenantIdOf } from "@/lib/knowledge/tenant";

/** 404 đồng nhất cho mọi truy cập ngoài tenant/scope — không lộ sự tồn tại. */
export async function denied(targetType: string, targetId: number | string): Promise<never> {
  await audit("scope.denied", { targetType, targetId });
  throw new HttpError(404, "NOT_FOUND", "Không tìm thấy tài nguyên trong phạm vi được phép.");
}

/** HttpError → status tương ứng; lỗi không mong đợi → 500 chung (không lộ chi tiết nội bộ). */
export function fail(e: unknown): Response {
  if (e instanceof HttpError) return problem(e.status, e.message, e.detail ?? e.code);
  return problem(500, "Lỗi máy chủ nội bộ.");
}

/** authorize(action) → resolve tenant → fn; mọi HttpError → problem+json qua fail(). */
export async function withTenant(
  action: "read" | "manage",
  fn: (ctx: { session: SessionPayload; tenantId: number }) => Promise<Response>,
): Promise<Response> {
  const auth = await authorize(action);
  if (auth.response) return auth.response;
  try {
    const tenantId = await tenantIdOf(auth.session);
    return await fn({ session: auth.session, tenantId });
  } catch (e) { return fail(e); }
}

export function asObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
