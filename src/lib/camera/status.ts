export type StreamState = "off" | "connecting" | "live" | "lost";

/**
 * Nhãn trên khung phát. Webcam phát trên trình duyệt nên dùng nhãn + trạng thái riêng
 * (Đang bật/Chưa bật), không mượn nhãn "Trực tiếp"/"offline" của pipeline RTSP;
 * nguồn demo luôn ghi rõ là mô phỏng.
 */
export function streamBadge(sourceType: string, state: StreamState): string {
  if (state === "connecting") return "Đang kết nối…";
  if (state === "lost") return sourceType === "webcam" ? "Mất kết nối webcam" : "Mất kết nối camera";
  if (sourceType === "webcam") return state === "live" ? "Webcam trên trình duyệt · Đang bật" : "Webcam trên trình duyệt · Chưa bật";
  if (sourceType === "demo") return "Nguồn mô phỏng";
  return state === "live" ? "Trực tiếp" : "Camera IP chưa có hình";
}

/** Trạng thái trong danh sách camera. Webcam không có pipeline phía máy chủ nên không gọi Online/Offline. */
export function listStatus(cam: { sourceType: string; status: string; streamName?: string | null }): { label: string; tone: "ok" | "warn" | "muted" } {
  if (cam.sourceType === "webcam") return { label: "Trên trình duyệt", tone: "muted" };
  if (cam.sourceType === "rtsp") return cam.streamName ? { label: "Đã đăng ký", tone: "ok" } : { label: "Chưa kết nối", tone: "warn" };
  if (cam.status === "demo") return { label: "Mô phỏng", tone: "muted" };
  return cam.status === "online" ? { label: "Online", tone: "ok" } : { label: "Offline", tone: "muted" };
}
