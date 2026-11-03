/**
 * T-1341 — xuất clip from→to từ các segment mediaMTX bằng ffmpeg stream copy.
 *
 * Thuần logic chọn/đối số: không đụng DB, không đọc file — test được không cần
 * server. CẤM re-encode: mọi lệnh ffmpeg sinh ra đều `-c copy`, không filter,
 * không `-c:v`. 1 segment ⇒ `-ss/-t` trước `-i`; nhiều segment ⇒ concat demuxer
 * với manifest có inpoint/outpoint theo từng file (đúng cả khi segment cách
 * nhau khoảng trống), `-ss/-t` áp lên kết quả ghép.
 */

export type ClipRange = { from: Date; to: Date };

const MAX_SPAN_MS = 600_000; // clip tối đa 10 phút
const FUTURE_SKEW_MS = 60_000; // cho phép lệch giờ client nhỏ
const MAX_AGE_MS = 400 * 86_400_000; // không cho clip từ quá 400 ngày trước
export const CLIP_TIMEOUT_MS = 30_000; // tự kill ffmpeg quá hạn (spawn không hỗ trợ AbortSignal.timeout)

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/**
 * Ràng buộc khoảng clip: from < to; span ≤ 600 s; to ≤ now + 60 s (dung lệch
 * giờ); from ≥ now - 400 ngày. Trả {ok:false, code} để route map thẳng ra 400.
 */
export function validateClipRange(
  r: ClipRange,
  now: Date = new Date(),
): { ok: true } | { ok: false; code: string; message: string } {
  if (!(r.from instanceof Date) || !(r.to instanceof Date) || Number.isNaN(r.from.getTime()) || Number.isNaN(r.to.getTime()))
    return { ok: false, code: "INVALID_RANGE", message: "from/to phải là thời điểm RFC3339 hợp lệ." };
  if (r.from.getTime() >= r.to.getTime())
    return { ok: false, code: "INVALID_RANGE", message: "from phải nhỏ hơn to." };
  if (r.to.getTime() - r.from.getTime() > MAX_SPAN_MS)
    return { ok: false, code: "SPAN_TOO_LONG", message: "Khoảng clip tối đa 600 giây." };
  if (r.to.getTime() > now.getTime() + FUTURE_SKEW_MS)
    return { ok: false, code: "FUTURE_RANGE", message: "to không được nằm trong tương lai." };
  if (r.from.getTime() < now.getTime() - MAX_AGE_MS)
    return { ok: false, code: "RANGE_TOO_OLD", message: "from quá xa trong quá khứ (giới hạn 400 ngày)." };
  return { ok: true };
}

/**
 * Segment giao với [from,to): start < to && start+duration > from. Bỏ segment
 * có durationSec ≤ 0 (file rỗng/không đo được — stream copy không cắt được
 * khoảng không biết độ dài). Kết quả sắp tăng dần theo start.
 */
export function pickClipSegments(
  segs: { file: string; start: Date; durationSec?: number }[],
  r: ClipRange,
): { file: string; start: Date; durationSec: number }[] {
  const fromMs = r.from.getTime();
  const toMs = r.to.getTime();
  return segs
    .filter((s) => {
      const dur = s.durationSec ?? 0;
      if (dur <= 0) return false;
      return s.start.getTime() < toMs && s.start.getTime() + dur * 1000 > fromMs;
    })
    .map((s) => ({ file: s.file, start: s.start, durationSec: s.durationSec as number }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function fmtSec(v: number): string {
  return String(Math.max(0, Math.round(v * 1000) / 1000));
}

/**
 * Manifest concat demuxer: mỗi file kèm `inpoint`/`outpoint` (giây trong file)
 * khi khoảng clip cắt lửng file đó — vì vậy khoảng trống giữa các segment không
 * làm lệch mapping thời gian như khi `-ss` trên stream đã ghép. Path đã qua
 * SEGMENT_RE/KEY_RE nên không chứa ký tự lạ; vẫn quote + đổi `\` → `/` cho
 * Windows (concat coi `\` là escape).
 */
export function buildConcatManifest(
  segs: { path: string; start: Date; durationSec: number }[],
  r: ClipRange,
): string {
  const lines: string[] = [];
  for (const s of segs) {
    lines.push(`file '${s.path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
    const segStart = s.start.getTime();
    const inMs = Math.max(0, r.from.getTime() - segStart);
    const outMs = Math.min(s.durationSec * 1000, r.to.getTime() - segStart);
    if (inMs > 0) lines.push(`inpoint ${fmtSec(inMs / 1000)}`);
    if (outMs < s.durationSec * 1000) lines.push(`outpoint ${fmtSec(outMs / 1000)}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Đối số ffmpeg, luôn kết thúc bằng output (mặc định `pipe:1`).
 * - 1 file:   ffmpeg -hide_banner -loglevel error -ss <off> -t <dur> -i <file>
 *             -c copy -movflags +faststart -f mp4 <out>
 * - nhiều:    ffmpeg ... -f concat -safe 0 -i <listFile> [-ss <off>] -t <dur>
 *             -c copy -movflags +faststart -f mp4 <out>
 * Concat: `-ss` chỉ thêm khi offsetSec > 0 — `-ss 0` ở vị trí output với stream
 * copy cắt mất ~1 GOP đầu; in/outpoint trong manifest đã trim chính xác.
 */
export function buildClipArgs(input: {
  files: string[];
  offsetSec: number;
  durationSec: number;
  /** Manifest concat (buildConcatManifest) — bắt buộc khi files.length > 1. */
  listFile?: string;
  /** Đích ghi; mặc định stdout `pipe:1`. */
  out?: string;
}): string[] {
  if (!input.files.length) throw new Error("buildClipArgs cần ít nhất 1 file.");
  const args = ["-hide_banner", "-loglevel", "error"];
  if (input.files.length === 1) {
    args.push("-ss", fmtSec(input.offsetSec), "-t", fmtSec(input.durationSec), "-i", input.files[0]);
  } else {
    if (!input.listFile) throw new Error("listFile bắt buộc khi ghép nhiều segment.");
    args.push("-f", "concat", "-safe", "0", "-i", input.listFile);
    if (input.offsetSec > 0) args.push("-ss", fmtSec(input.offsetSec));
    args.push("-t", fmtSec(input.durationSec));
  }
  args.push("-c", "copy", "-movflags", "+faststart", "-f", "mp4", input.out ?? "pipe:1");
  return args;
}
