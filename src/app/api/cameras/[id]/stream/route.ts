import { authorize } from "@/lib/auth-server";
import { authorizeResource } from "@/lib/scope";
import { problem } from "@/lib/audit";
import { getMjpegStream } from "@/lib/camera/stream";
import { createLimiter } from "@/lib/stream-limiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// M7 — cap consumer toàn process (một instance module-level duy nhất).
// <=0 / không hợp lệ = unlimited, xem src/lib/stream-limiter.ts và .env.example.
const MAX = Number(process.env.MAX_CONSUMERS ?? "8");
const limiter = createLimiter(MAX);
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return problem(400, "Camera ID không hợp lệ");
  const scoped = await authorizeResource(auth.session, "camera", id);
  if (!scoped.ok) return scoped.response;
  const cam = scoped.row;
  if (!cam.enabled || cam.sourceType !== "rtsp" || !cam.streamName) return problem(404, "Camera chưa kết nối");
  if (!limiter.acquire()) {
    const res = problem(429, "Quá nhiều kết nối xem trực tiếp");
    res.headers.set("Retry-After", "5");
    return res;
  }
  try {
    const upstream = await getMjpegStream(cam.streamName);
    if (!upstream.ok || !upstream.body) { limiter.release(); return problem(503, "Luồng camera chưa sẵn sàng"); }
    const mime = upstream.headers.get("content-type") || "";
    if (!mime.toLowerCase().startsWith("multipart/x-mixed-replace")) {
      limiter.release();
      try { await upstream.body.cancel(); } catch { /* upstream đã tự đóng */ }
      return problem(502, "Nguồn stream trả về dữ liệu không phải MJPEG");
    }
    const reader = upstream.body.getReader();
    let released = false;
    // Nhả ĐÚNG 1 slot dù stream chết theo đường nào: client ngắt (cancel),
    // nguồn kết thúc (done) hay upstream lỗi — không release kép (slot của
    // consumer khác đang giữ không được trả nhầm), không rò slot.
    const releaseOnce = () => { if (!released) { released = true; limiter.release(); } };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (controller.desiredSize === null) return; // cancel thắng race với pull đang chờ
          if (done) { releaseOnce(); controller.close(); return; }
          controller.enqueue(value);
        } catch (error) {
          releaseOnce();
          if (controller.desiredSize !== null) controller.error(error);
        }
      },
      async cancel(reason) {
        releaseOnce();
        try { await reader.cancel(reason); } catch { /* upstream đã tự đóng */ }
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": mime, "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" } });
  } catch { limiter.release(); return problem(503, "Không truy cập được camera", "Kiểm tra go2rtc và mã hóa video (MJPEG có thể cần FFmpeg để chuyển mã)."); }
}
