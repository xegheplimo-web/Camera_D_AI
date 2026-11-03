import { HttpError, readJsonBody } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { undoMerge } from "@/lib/knowledge/merge";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST — hoàn tác một lần gộp trong 24 h (T-1355). */
export async function POST(req: Request) {
  return withTenant("manage", async ({ tenantId, session }) => {
    const body = await readJsonBody(req);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new HttpError(400, "INVALID_BODY", "Body phải là object JSON.");

    const logId = Number((body as Record<string, unknown>).logId);
    if (!Number.isInteger(logId) || logId <= 0) throw new HttpError(400, "INVALID_LOG_ID", "logId phải là số nguyên dương.");

    const result = await undoMerge({ tenantId, logId, actor: session.sub });
    return Response.json({ ok: true, ...result });
  });
}
