import { db } from "@/db";
import { assets } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createHash } from "crypto";
import { audit, problem } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";

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

export async function POST(req: Request) {
  const auth = await authorize("capture");
  if (auth.response) return auth.response;
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

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const existing = await db.select({ id: assets.id, sha256: assets.sha256 }).from(assets).where(eq(assets.sha256, sha256)).limit(1);
  if (existing.length) return Response.json({ id: existing[0].id, sha256, duplicate: true, url: `/api/assets/${existing[0].id}` });

  const [row] = await db
    .insert(assets)
    .values({
      kind: mime.startsWith("video") ? "video" : "image",
      mime,
      sha256,
      data: base64,
      width,
      height,
      sizeBytes: buf.length,
      origin: ["upload", "capture", "clip"].includes(b?.origin) ? b.origin : "upload",
      cameraId: b?.cameraId ? Number(b.cameraId) : null,
      uploadedBy: auth.session.name,
    })
    .returning({ id: assets.id });
  await audit(`asset.${b?.origin ?? "upload"}`, { targetType: "asset", targetId: row.id, detail: `${mime} ${buf.length}B` });
  return Response.json({ id: row.id, sha256, url: `/api/assets/${row.id}`, mime }, { status: 201 });
}
