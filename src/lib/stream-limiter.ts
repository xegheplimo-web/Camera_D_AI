/**
 * M7 — cap số consumer MJPEG đồng thời phía app. Mỗi tab xem trực tiếp giữ một
 * ffmpeg/relay phía go2rtc suốt thời gian mở, nên không chặn sẽ cạn process khi
 * mở nhiều tab. max <= 0 hoặc không hữu hạn = KHÔNG giới hạn (acquire luôn true):
 * đây là chế độ "tắt cap" được công bố rõ trong .env.example, không phải
 * fallback âm thầm. Dependency-free, một instance module-level cho mỗi route ⇒
 * cap áp toàn process.
 */
export function createLimiter(max: number): {
  acquire(): boolean;
  release(): void;
  readonly active: number;
  readonly max: number;
} {
  const unlimited = !Number.isFinite(max) || max <= 0;
  let count = 0;
  return {
    acquire() {
      if (!unlimited && count >= max) return false;
      count += 1;
      return true;
    },
    release() {
      if (count > 0) count -= 1; // release kép không được làm count tụt âm
    },
    get active() {
      return count;
    },
    get max() {
      return max;
    },
  };
}
