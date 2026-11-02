/**
 * Next.js instrumentation: chạy một lần khi server khởi động (dev và start).
 * Detector camera chỉ bật khi env DETECT_ENABLED=true; bản thân startDetector
 * cũng tự kiểm tra env nên ở đây chỉ cần gọi.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startDetector } = await import("@/lib/camera/detector");
  startDetector();
  // Retention: chạy ngay 1 lần rồi lặp mỗi 24h; no-op khi retentionDays<=0.
  const { startRetention } = await import("@/lib/retention");
  startRetention();
}
