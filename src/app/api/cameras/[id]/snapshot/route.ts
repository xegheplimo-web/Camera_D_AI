import { authorize } from "@/lib/auth-server";
import { authorizeResource } from "@/lib/scope";
import { problem } from "@/lib/audit";
import { getMjpegStream } from "@/lib/camera/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const READ_TIMEOUT_MS = 8_000;
const MAX_BYTES = 8 * 1024 * 1024;
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

/**
 * Đọc tới frame JPEG hoàn chỉnh đầu tiên (SOI FFD8 … EOI FFD9) trong luồng
 * MJPEG multipart. Timeout ⇒ null; stream kết thúc/lỗi trước khi đủ frame ⇒
 * null. MAX_BYTES chặn producer lỗi phình buffer vô hạn trong budget đọc.
 */
async function readFirstJpeg(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Buffer | null> {
  const work = (async () => {
    let buf = Buffer.alloc(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return null;
      if (!value?.length) continue;
      buf = buf.length ? Buffer.concat([buf, value]) : Buffer.from(value);
      if (buf.length > MAX_BYTES) return null;
      const soi = buf.indexOf(SOI);
      if (soi < 0) continue;
      const eoi = buf.indexOf(EOI, soi + 2);
      if (eoi >= 0) return buf.subarray(soi, eoi + 2);
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * P3 — snapshot một frame JPEG cho tường camera (poll thay vì giữ MJPEG).
 * KHÔNG acquire slot của stream-limiter: request sống vài giây rồi đóng,
 * không chiếm ffmpeg/relay suốt phiên như /stream — 10 tile không đói slot
 * của màn xem đơn. Upstream được cancel trên MỌI đường thoát (finally).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return problem(400, "Camera ID không hợp lệ");
  const scoped = await authorizeResource(auth.session, "camera", id);
  if (!scoped.ok) return scoped.response;
  const cam = scoped.row;
  if (!cam.enabled || cam.sourceType !== "rtsp" || !cam.streamName) return problem(404, "Camera chưa kết nối");

  let upstream: Response;
  try {
    upstream = await getMjpegStream(cam.streamName);
  } catch {
    return problem(503, "Không truy cập được camera", "Kiểm tra go2rtc và nguồn RTSP của camera.");
  }
  if (!upstream.ok || !upstream.body) {
    try { await upstream.body?.cancel(); } catch { /* upstream đã tự đóng */ }
    return problem(503, "Luồng camera chưa sẵn sàng");
  }
  const mime = upstream.headers.get("content-type") || "";
  if (!mime.toLowerCase().startsWith("multipart/x-mixed-replace")) {
    try { await upstream.body.cancel(); } catch { /* upstream đã tự đóng */ }
    return problem(502, "Nguồn stream trả về dữ liệu không phải MJPEG");
  }

  const reader = upstream.body.getReader();
  try {
    const frame = await readFirstJpeg(reader);
    if (!frame) return problem(503, "Không lấy được khung hình từ camera");
    return new Response(new Uint8Array(frame), {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return problem(503, "Không truy cập được camera");
  } finally {
    try { await reader.cancel("snapshot xong — nhả upstream"); } catch { /* upstream đã tự đóng */ }
  }
}
