import { db } from "@/db";
import { cameras } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authorize } from "@/lib/auth-server";
import { audit, problem } from "@/lib/audit";
import { decryptSource, ensureGo2rtcStream } from "@/lib/camera/stream";
export const runtime = "nodejs";
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return problem(400, "Camera ID không hợp lệ");
  const [cam] = await db.select().from(cameras).where(eq(cameras.id, id)).limit(1);
  if (!cam || cam.sourceType !== "rtsp" || !cam.sourceCiphertext) return problem(404, "Không có camera IP tương ứng");
  try {
    const name = `dai_cam_${cam.id}`;
    await ensureGo2rtcStream(name, decryptSource(cam.sourceCiphertext));
    await db.update(cameras).set({ streamName: name, status: "degraded" }).where(eq(cameras.id, id));
    await audit("camera.reconnect", { targetType: "camera", targetId: id, detail: cam.sourceHost || "" });
    return Response.json({ ok: true, stream: `/api/cameras/${id}/stream`, note: "Đã đăng ký luồng; chờ hình ảnh để xác minh camera thực sự online." });
  } catch { return problem(503, "Không thể kết nối go2rtc", "Kiểm tra nguồn RTSP và dịch vụ go2rtc cục bộ, không gửi mật khẩu vào log."); }
}
