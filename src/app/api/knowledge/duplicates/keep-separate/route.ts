import { HttpError, readJsonBody } from "@/lib/http-guard";
import { withTenant } from "@/lib/knowledge/http";
import { getItem } from "@/lib/knowledge/items";
import { toIdentity } from "@/lib/knowledge/normalize";
import { keepSeparate } from "@/lib/knowledge/pairs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST — "Giữ riêng" cho một cặp (T-1356). Ghi quyết định, KHÔNG sửa item. */
export async function POST(req: Request) {
  return withTenant("manage", async ({ tenantId, session }) => {
    const body = await readJsonBody(req);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new HttpError(400, "INVALID_BODY", "Body phải là object JSON.");

    const b = body as Record<string, unknown>;
    const aId = Number(b.a);
    const bId = Number(b.b);
    if (!Number.isInteger(aId) || !Number.isInteger(bId) || aId <= 0 || bId <= 0)
      throw new HttpError(400, "INVALID_IDS", "a và b phải là số nguyên dương.");
    if (aId === bId) throw new HttpError(400, "SAME_ITEM", "Hai mục là một.");

    const [ia, ib] = await Promise.all([getItem(tenantId, aId), getItem(tenantId, bId)]);
    if (!ia || !ib) throw new HttpError(404, "NOT_FOUND", "Không tìm thấy mục trong cửa hàng này.");

    const side = (it: { id: number; title: string; custom: unknown }) => ({
      id: Number(it.id),
      title: it.title,
      identity: toIdentity((it.custom ?? {}) as Record<string, unknown>),
    });

    const res = await keepSeparate({ tenantId, a: side(ia), b: side(ib), actor: session.sub });
    return Response.json({ ok: true, ...res });
  });
}
