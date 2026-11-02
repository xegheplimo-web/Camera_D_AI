import { authorize } from "@/lib/auth-server";
import { authorizeResource } from "@/lib/scope";
import { problem } from "@/lib/audit";
import { getMjpegStream } from "@/lib/camera/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return problem(400, "Camera ID không hợp lệ");
  const scoped = await authorizeResource(auth.session, "camera", id);
  if (!scoped.ok) return scoped.response;
  const cam = scoped.row;
  if (!cam.enabled || cam.sourceType !== "rtsp" || !cam.streamName) return problem(404, "Camera chưa kết nối");
  try {
    const upstream = await getMjpegStream(cam.streamName);
    if (!upstream.ok || !upstream.body) return problem(503, "Luồng camera chưa sẵn sàng");
    const mime = upstream.headers.get("content-type") || "";
    if (!mime.toLowerCase().startsWith("multipart/x-mixed-replace")) return problem(502, "Nguồn stream trả về dữ liệu không phải MJPEG");
    return new Response(upstream.body, { status: 200, headers: { "Content-Type": mime, "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
  } catch { return problem(503, "Không truy cập được camera", "Kiểm tra go2rtc và mã hóa video (MJPEG có thể cần FFmpeg để chuyển mã)."); }
}
