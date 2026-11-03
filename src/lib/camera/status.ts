export type StreamState = "off" | "connecting" | "live" | "lost";
/** T-1319 — trạng thái kết nối thật của nguồn (probe mediaMTX / client state). */
export type ConnectionState = "online" | "offline" | "unknown";

/**
 * Nhãn trên khung phát. Webcam phát trên trình duyệt nên dùng nhãn + trạng thái riêng
 * (Đang bật/Chưa bật), không mượn nhãn "Trực tiếp"/"offline" của pipeline RTSP;
 * nguồn demo luôn ghi rõ là mô phỏng. Khi có `connection` thật (từ /api/cameras/health),
 * RTSP chỉ ghi "Trực tiếp" khi connection === "online".
 */
export function streamBadge(sourceType: string, state: StreamState, connection?: ConnectionState): string {
  if (state === "connecting") return "Đang kết nối…";
  if (state === "lost") return sourceType === "webcam" ? "Mất kết nối webcam" : "Mất kết nối camera";
  if (sourceType === "webcam") return state === "live" ? "Webcam trên trình duyệt · Đang bật" : "Webcam trên trình duyệt · Chưa bật";
  if (sourceType === "demo") return "Nguồn mô phỏng";
  if (connection === "offline") return "Mất kết nối";
  if (connection === "unknown") return "Không rõ kết nối";
  return state === "live" ? "Trực tiếp" : "Camera IP chưa có hình";
}

/**
 * Trạng thái trong danh sách camera. Webcam không có pipeline phía máy chủ nên không gọi Online/Offline.
 * `connection` là kết quả probe thật (GET /api/cameras/health); chưa có dữ liệu probe thì giữ
 * nhãn đăng ký cũ (Đã đăng ký/Chưa kết nối) thay vì kết luận online từ cột status.
 */
export function listStatus(
  cam: { sourceType: string; status: string; streamName?: string | null },
  connection?: ConnectionState
): { label: string; tone: "ok" | "warn" | "muted" } {
  if (cam.sourceType === "webcam") return { label: "Trên trình duyệt", tone: "muted" };
  if (cam.sourceType === "rtsp") {
    if (connection === "online") return { label: "Trực tiếp", tone: "ok" };
    if (connection === "offline") return { label: "Mất kết nối", tone: "warn" };
    if (connection === "unknown") return { label: "Không rõ kết nối", tone: "muted" };
    return cam.streamName ? { label: "Đã đăng ký", tone: "ok" } : { label: "Chưa kết nối", tone: "warn" };
  }
  if (cam.sourceType === "demo" || cam.status === "demo") return { label: "Mô phỏng", tone: "muted" };
  return cam.status === "online" ? { label: "Online", tone: "ok" } : { label: "Offline", tone: "muted" };
}
