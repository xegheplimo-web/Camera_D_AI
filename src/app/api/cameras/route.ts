import { db } from "@/db";
import { cameraSettings, cameras } from "@/db/schema";
import { ensureSeed } from "@/lib/seed";
import { audit, problem } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { ensureRecordingPath } from "@/lib/camera/recorder";
import { encryptSource, ensureGo2rtcStream, maskCameraUrl, validateCameraUrl } from "@/lib/camera/stream";
import { publicCamera } from "@/lib/camera/public";
import { eq, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  await ensureSeed();
  const rows = await db.select().from(cameras).orderBy(cameras.id);
  return Response.json(rows.map(publicCamera), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  const body = await req.json().catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, 60);
  const location = String(body?.location ?? "").trim().slice(0, 80);
  const sourceType = body?.sourceType === "rtsp" ? "rtsp" : body?.sourceType === "webcam" ? "webcam" : "demo";
  if (!name || !location) return problem(400, "Thiếu tên hoặc vị trí camera");
  let sourceCiphertext: string | null = null;
  let sourceHost: string | null = null;
  let sourceUrl: string | null = null;
  if (sourceType === "rtsp") {
    try {
      sourceUrl = String(body?.rtspUrl ?? "");
      const parsed = validateCameraUrl(sourceUrl);
      sourceCiphertext = encryptSource(sourceUrl);
      sourceHost = `${parsed.hostname}:${parsed.port || "554"}`;
    } catch (e) { return problem(400, e instanceof Error ? e.message : "RTSP không hợp lệ"); }
  }
  const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(cameras);
  const thumbs = ["/cams/cam1.jpg", "/cams/cam2.jpg", "/cams/cam3.jpg", "/cams/cam4.jpg"];
  const [row] = await db.insert(cameras).values({
    code: `CAM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    name, location, sourceType, sourceCiphertext, sourceHost,
    thumbnail: sourceType === "demo" ? thumbs[c % 4] : null,
    status: sourceType === "demo" ? "demo" : "offline",
  }).returning();
  let connected = false;
  let warning: string | null = null;
  if (sourceType === "rtsp" && sourceUrl) {
    try {
      await ensureGo2rtcStream(`dai_cam_${row.id}`, sourceUrl);
      connected = true;
      await db.update(cameras).set({ streamName: `dai_cam_${row.id}`, status: "degraded" }).where(eq(cameras.id, row.id));
    } catch {
      warning = "Đã lưu cấu hình mã hóa, nhưng go2rtc chưa sẵn sàng. Vào Camera > Kết nối lại sau khi bật go2rtc.";
    }
  }
  // T-1340: tạo path recorder khi caller yêu cầu ghi ngay (settings mặc định recordEnabled=false ⇒ bỏ qua).
  let recording = false;
  if (connected && sourceUrl && body?.recordEnabled === true) {
    const st = await ensureRecordingPath({ streamName: `dai_cam_${row.id}`, sourceUrl });
    if (st.reachable && st.recording) {
      await db.insert(cameraSettings).values({ cameraId: row.id, tenantId: row.tenantId })
        .onConflictDoNothing({ target: cameraSettings.cameraId });
      await db.update(cameraSettings).set({ recordEnabled: true }).where(eq(cameraSettings.cameraId, row.id));
      recording = true;
    } else {
      warning = "Đã lưu camera nhưng recorder mediaMTX không phản hồi — bật 'Lưu video' lại trong Cài đặt.";
    }
  }
  await audit("camera.create", { targetType: "camera", targetId: row.id, detail: `${name} (${sourceType}, ${sourceHost || "no IP"})` });
  return Response.json({ ...publicCamera(row), connected, recording, warning, sourceHint: sourceUrl ? maskCameraUrl(sourceUrl) : null }, { status: 201 });
}
