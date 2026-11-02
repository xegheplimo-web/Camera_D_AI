import { db } from "@/db";
import { cameras } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authorize } from "@/lib/auth-server";
import { problem } from "@/lib/audit";
import { getMjpegStream } from "@/lib/camera/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return problem(400, "Camera ID không hợp lệ");
  const [cam] = await db.select({ sourceType: cameras.sourceType, streamName: cameras.streamName }).from(cameras).where(eq(cameras.id, id)).limit(1);
  if (!cam || cam.sourceType !== "rtsp" || !cam.streamName) return problem(404, "Camera chưa kết nối");
  try {
    const upstream = await getMjpegStream(cam.streamName);
    if (!upstream.ok || !upstream.body) return problem(503, "Luồng camera chưa sẵn sàng");
    const mime = upstream.headers.get("content-type") || "";
    if (!mime.toLowerCase().startsWith("multipart/x-mixed-replace")) return problem(502, "Gateway trả về dữ liệu không phải MJPEG");
    return new Response(upstream.body, { status: 200, headers: { "Content-Type": mime, "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
  } catch { return problem(503, "Không truy cập được camera", "Kiểm tra go2rtc và mã hóa video (MJPEG có thể cần FFmpeg để chuyển mã)."); }
}
