import { after } from "next/server";
import { db } from "@/db";
import { extractions } from "@/db/schema";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { ensureSeed } from "@/lib/seed";
import { thumbMap } from "@/lib/qa";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { authorizeResource, extractionScope } from "@/lib/scope";
import { tenantIdOf } from "@/lib/knowledge/tenant";
import { getSettings } from "@/lib/settings";
import { enqueueJob, dispatchJobs, jobView } from "@/lib/ai/jobs";
import { aiProblem, readJson, requestKey, throttle } from "@/lib/ai/http";
import { validateRoi } from "@/lib/ai/routing";
import { AiError } from "@/lib/ai/types";
import { parseProductMeta } from "@/lib/product";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(req: Request) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  await ensureSeed();
  const settings = await getSettings();
  const u = new URL(req.url);
  const q = u.searchParams.get("q");
  const status = u.searchParams.get("status");
  const conds = [];
  if (q) conds.push(or(ilike(extractions.note, `%${q}%`), ilike(extractions.title, `%${q}%`), sql`${extractions.result}::text ilike ${"%" + q + "%"}`)!);
  if (status) conds.push(eq(extractions.status, status));
  if (!settings.demoMode) conds.push(sql`${extractions.source} <> 'demo'`);
  const scope = extractionScope(auth.session);
  if (scope) conds.push(scope);
  const rows = await db.select().from(extractions).where(conds.length ? and(...conds) : undefined).orderBy(desc(extractions.createdAt)).limit(60);
  const tm = await thumbMap(auth.session, rows.map((r) => r.assetId));
  return Response.json(rows.map((r) => ({ ...r, thumb: tm.get(r.assetId) ?? null })));
}
export async function POST(req: Request) {
  const auth = await authorize("capture");
  if (auth.response) return auth.response;
  try {
    throttle(`extract:${auth.session.sub}`, 15);
    const b = await readJson(req);
    const assetId = Number(b.assetId);
    const note = typeof b.note === "string" ? b.note.trim() : "";
    if (!Number.isSafeInteger(assetId) || assetId <= 0 || !note || note.length > 4000) throw new AiError("INVALID_EXTRACTION", "Cần ảnh hợp lệ và ghi chú từ 1–4.000 ký tự.", 400);
    const scoped = await authorizeResource(auth.session, "asset", assetId);
    if (!scoped.ok) throw new AiError("ASSET_NOT_FOUND", "Không tìm thấy ảnh gốc trong phạm vi được phép.", 404);
    const asset = scoped.row;
    if (asset.kind !== "image") throw new AiError("ASSET_NOT_FOUND", "Không tìm thấy ảnh gốc.", 404);
    const roi = validateRoi(b.roi);
    const title = typeof b.title === "string" ? b.title.trim().slice(0, 120) || "Trích xuất ảnh" : "Trích xuất ảnh";
    const tags = Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === "string").map((t) => t.slice(0, 40)).slice(0, 10) : [];
    const taskType = typeof b.taskType === "string" && ["freeform", "object_count", "ocr", "plate", "describe", "table"].includes(b.taskType) ? b.taskType : "freeform";
    let meta;
    try { meta = parseProductMeta(b); } catch (error) { throw new AiError("INVALID_PRODUCT", error instanceof Error ? error.message : "Thông tin sản phẩm không hợp lệ.", 400); }
    const source = asset.origin === "demo" ? "demo" : "live";
    // Saving a note is a Gateway operation: no Hermes/model dependency.
    if (b.action === "draft") {
      const [row] = await db.insert(extractions).values({ tenantId: await tenantIdOf(auth.session), assetId, note, title, tags, roi, taskType, ...meta, status: "DRAFT", source, createdBy: auth.session.name, userId: auth.session.sub }).returning();
      await audit("note.save", { targetType: "extraction", targetId: row.id });
      return Response.json({ ...row, thumb: asset.url && !asset.url.startsWith("local:") ? asset.url : `/api/assets/${asset.id}` }, { status: 201 });
    }
    const settings = await getSettings();
    // Ignore all client-supplied local detections/OCR/counts. Worker reads stored original pixels.
    const { job, duplicate } = await enqueueJob("extract", {
      assetId, note, roi, taskType, demoMode: settings.demoMode,
      allowRemote: settings.remoteProcessingAllowed && b.allowRemote === true, asOf: new Date().toISOString(),
    }, auth.session, `extract:${requestKey(req, b)}`, { title, tags, source, ...meta });
    after(() => dispatchJobs());
    return Response.json({ accepted: true, extractionId: job.input.extractionId, job: jobView(job), duplicate }, { status: 202 });
  } catch (e) { return aiProblem(e); }
}
