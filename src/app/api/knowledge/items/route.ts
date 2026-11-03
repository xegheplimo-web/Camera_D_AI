import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { HttpError, readJsonBody } from "@/lib/http-guard";
import { fail } from "@/lib/knowledge/http";
import { tenantIdOf } from "@/lib/knowledge/tenant";
import { createItem, ITEM_SCOPES, listItems } from "@/lib/knowledge/items";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET — danh mục tri thức của tenant; lọc ?scope= &cameraId= &q= (title/sku/note). */
export async function GET(req: Request) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  try {
    const tenantId = await tenantIdOf(auth.session);
    const u = new URL(req.url);
    const scope = u.searchParams.get("scope") ?? undefined;
    if (scope !== undefined && !(ITEM_SCOPES as readonly string[]).includes(scope))
      throw new HttpError(400, "INVALID_SCOPE", `scope phải là một trong: ${ITEM_SCOPES.join("|")}.`);
    const cameraParam = u.searchParams.get("cameraId");
    let cameraId: number | undefined;
    if (cameraParam !== null) {
      cameraId = Number(cameraParam);
      if (!Number.isSafeInteger(cameraId) || cameraId <= 0) throw new HttpError(400, "INVALID_CAMERA", "cameraId phải là số nguyên dương.");
    }
    const q = u.searchParams.get("q")?.trim() || undefined;
    return Response.json(await listItems(tenantId, { scope, cameraId, q }));
  } catch (e) { return fail(e); }
}

/** POST — tạo mục mới {scope?, cameraId?, title, sku?, note?, priceVnd?, custom?}. */
export async function POST(req: Request) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  try {
    const body = await readJsonBody(req);
    const tenantId = await tenantIdOf(auth.session);
    const item = await createItem(tenantId, auth.session, body);
    await audit("knowledge_item.create", { targetType: "knowledge_item", targetId: item.id });
    return Response.json(item, { status: 201 });
  } catch (e) { return fail(e); }
}
