/**
 * Keep-warm producer go2rtc: giữ một consumer MJPEG nội bộ cho mỗi camera RTSP
 * đang bật, để producer `ffmpeg:#video=mjpeg` không bị go2rtc thu hồi sau ~30-60s
 * idle. Không có consumer thì frame đầu tiên sau idle phải chờ ffmpeg spawn +
 * keyframe tiếp theo của camera (~5-6s với nguồn 4MP) — đây là nguyên nhân
 * "vào trang camera hiện hình chậm".
 *
 * Chi phí: ffmpeg transcode chạy liên tục nhưng đo thực tế chỉ ~5% một nhân
 * (nguồn 2880x1620); băng thông loopback ~2-3MB/s mỗi camera — chấp nhận được
 * đổi lại mở trang là có hình ngay.
 *
 * Consumer đi THẲNG tới go2rtc loopback (không qua route stream của app) nên
 * không chiếm slot stream-limiter và không cần session. Tắt bằng
 * GO2RTC_KEEPWARM=0. Chạy từ instrumentation register(), một instance/process.
 * Logic timer/map tách sang keepwarm-core.ts để test được không cần DB.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { cameras } from "@/db/schema";
import { go2rtcBase } from "@/lib/camera/stream";
import { createKeepWarm, keepWarmEnabled } from "@/lib/camera/keepwarm-core";

const SCAN_MS = 60_000;      // đối chiếu danh sách camera định kỳ
const RETRY_MS = 5_000;      // backoff khi consumer rớt
const READ_TIMEOUT_MS = 30_000; // upstream im quá lâu ⇒ coi như rớt, kết nối lại

async function pump(streamName: string, signal: AbortSignal): Promise<void> {
  const url = `${go2rtcBase()}/api/stream.mjpeg?${new URLSearchParams({ src: streamName })}`;
  for (;;) {
    if (signal.aborted) return;
    try {
      const res = await fetch(url, { signal, cache: "no-store" });
      if (!res.ok || !res.body) throw new Error(`go2rtc trả ${res.status}`);
      const reader = res.body.getReader();
      // Đọc và bỏ dữ liệu — chỉ cần giữ consumer sống. Watchdog: upstream im
      // quá READ_TIMEOUT_MS (go2rtc giữ socket mở nhưng producer chết) thì hủy
      // reader để vòng ngoài reconnect, tránh consumer "xác" không giữ ấm được.
      try {
        for (;;) {
          let watchdog: ReturnType<typeof setTimeout> | undefined;
          const stalled = new Promise<never>((_, rej) => {
            watchdog = setTimeout(() => rej(new Error("upstream im lặng")), READ_TIMEOUT_MS);
          });
          try {
            const chunk = await Promise.race([reader.read(), stalled]);
            if (chunk.done) break;
          } finally {
            clearTimeout(watchdog);
          }
        }
      } finally {
        // Trả socket về pool khi stream kết thúc hoặc watchdog bắn — nếu không,
        // reader đang chờ read() rò một connection mỗi lần upstream chết treo.
        reader.cancel().catch(() => {});
      }
    } catch {
      // upstream lỗi/hủy — rơi xuống backoff rồi thử lại
    }
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

async function listStreams(): Promise<Map<number, string>> {
  const rows = await db
    .select({ id: cameras.id, streamName: cameras.streamName })
    .from(cameras)
    .where(and(eq(cameras.enabled, true), eq(cameras.sourceType, "rtsp"), isNotNull(cameras.streamName)));
  const want = new Map<number, string>();
  for (const r of rows) if (r.streamName) want.set(r.id, r.streamName);
  return want;
}

const keepWarm = createKeepWarm({
  isEnabled: () => keepWarmEnabled(),
  listStreams,
  runConsumer: pump,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  scanMs: SCAN_MS,
});

/** Gọi từ instrumentation register(). Idempotent; tắt bằng GO2RTC_KEEPWARM=0. */
export function startStreamKeepWarm(): void {
  keepWarm.start();
}

export function stopStreamKeepWarm(): void {
  keepWarm.stop();
}
