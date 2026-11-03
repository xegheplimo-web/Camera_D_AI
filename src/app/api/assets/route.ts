import { db } from "@/db";
import { assets } from "@/db/schema";
import { and, desc, eq, type SQL } from "drizzle-orm";
import { createHash } from "crypto";
import { audit, problem } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { enqueueJob } from "@/lib/ai/jobs";
import { errorInfo } from "@/lib/ai/types";
import { getSettings } from "@/lib/settings";
import { fail, queryCameraId, withTenant } from "@/lib/knowledge/http";
import { cameraInTenant } from "@/lib/knowledge/items";
import { tenantIdOf } from "@/lib/knowledge/tenant";
import { assetReadScope } from "@/lib/scope";
import type { SessionPayload } from "@/lib/token";

export const dynamic = "force-dynamic";

const MAX = 25 * 1024 * 1024;

function sniff(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video/webm";
  if (buf.slice(4, 8).toString() === "ftyp") return "video/mp4";
  return null;
}

/**
 * Lập chỉ mục là tác vụ nền: enqueue thất bại (hàng đợi đầy, lỗi DB) không được
 * làm mất asset vừa lưu. Không dispatch tại đây — job được nhận bởi
 * /api/internal/jobs/dispatch hoặc next.after() của các route AI khác.
 */
async function enqueueIndex(session: SessionPayload, assetId: number, kind: string) {
  if (kind !== "image") return;
  try {
    const settings = await getSettings();
    await enqueueJob("asset.index", { assetId, demoMode: settings.demoMode, allowRemote: settings.remoteProcessingAllowed, asOf: new Date().toISOString() }, session, `asset:${assetId}`);
  } catch (e) {
    await audit("asset.index.enqueue_failed", { targetType: "asset", targetId: assetId, detail: errorInfo(e).code });
  }
}

/** GET — danh sách asset của tenant trong read-scope của phiên; lọc ?cameraId=. */
export async function GET(req: Request) {
  return withTenant("read", async ({ session, tenantId }) => {
    const conds: SQL[] = [eq(assets.tenantId, tenantId)];
    const scope = assetReadScope(session);
    if (scope) conds.push(scope);
    const cameraId = queryCameraId(new URL(req.url));
    if (cameraId !== undefined) conds.push(eq(assets.cameraId, cameraId));
    const rows = await db
      .select({ id: assets.id, kind: assets.kind, mime: assets.mime, sha256: assets.sha256, cameraId: assets.cameraId, origin: assets.origin,
        width: assets.width, height: assets.height, sizeBytes: assets.sizeBytes, uploadedBy: assets.uploadedBy, createdAt: assets.createdAt })
      .from(assets).where(and(...conds)).orderBy(desc(assets.createdAt), desc(assets.id)).limit(100);
    return Response.json(rows.map((r) => ({ ...r, url: `/api/assets/${r.id}` })));
  });
}

export async function POST(req: Request) {
  const auth = await authorize("capture");
  if (auth.response) return auth.response;
  let tenantId: number;
  try { tenantId = await tenantIdOf(auth.session); } catch (e) { return fail(e); }
  const b = await req.json().catch(() => null);
  const dataUrl = String(b?.dataUrl ?? "");
  const m = /^data:([\w/+.-]+);base64,(.*)$/.exec(dataUrl.slice(0, 100) + "");
  if (!m) return problem(400, "Dữ liệu ảnh không hợp lệ", "Cần data URL base64");
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const buf = Buffer.from(base64, "base64");
  if (buf.length > MAX) return problem(413, "Tệp quá lớn", "Tối đa 25 MB/tệp");
  const mime = sniff(buf);
  if (!mime) return problem(415, "Định dạng không hỗ trợ", "Chỉ nhận JPEG, PNG, WEBP hoặc video WEBM/MP4 (kiểm tra magic bytes)");
  const width = Number(b?.width) || null;
  const height = Number(b?.height) || null;
  if (width && height && width * height > 50_000_000) return problem(413, "Ảnh quá nhiều điểm ảnh");

  let cameraId: number | null = null;
  if (b?.cameraId !== undefined && b?.cameraId !== null) {
    try { cameraId = await cameraInTenant(tenantId, b.cameraId); } catch (e) { return fail(e); }
  }

  const kind = mime.startsWith("video") ? "video" : "image";
  const sha256 = createHash("sha256").update(buf).digest("hex");
  // Dedup is per owner: another user's identical file must not disclose or share their asset id.
  const existing = await db.select({ id: assets.id, kind: assets.kind, cameraId: assets.cameraId }).from(assets)
    .where(and(eq(assets.sha256, sha256), eq(assets.userId, auth.session.sub))).limit(1);
  if (existing.length) {
    // Bản ghi cũ chưa gắn camera thì bổ sung liên kết; enqueue vẫn idempotent theo asset:<id>.
    if (cameraId !== null && existing[0].cameraId === null)
      await db.update(assets).set({ cameraId }).where(eq(assets.id, existing[0].id));
    await enqueueIndex(auth.session, existing[0].id, existing[0].kind);
    return Response.json({ id: existing[0].id, sha256, duplicate: true, url: `/api/assets/${existing[0].id}` });
  }

  const [row] = await db
    .insert(assets)
    .values({
      tenantId,
      kind,
      mime,
      sha256,
      data: base64,
      width,
      height,
      sizeBytes: buf.length,
      origin: ["upload", "capture", "clip"].includes(b?.origin) ? b.origin : "upload",
      cameraId,
      uploadedBy: auth.session.name,
      userId: auth.session.sub,
    })
    .returning({ id: assets.id });
  await enqueueIndex(auth.session, row.id, kind);
  await audit(`asset.${b?.origin ?? "upload"}`, { targetType: "asset", targetId: row.id, detail: `${mime} ${buf.length}B` });
  return Response.json({ id: row.id, sha256, url: `/api/assets/${row.id}`, mime }, { status: 201 });
}
