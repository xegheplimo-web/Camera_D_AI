import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { audit, problem } from "@/lib/audit";
import { HttpError } from "@/lib/http-guard";
import { denied, queryCameraId, withTenant } from "@/lib/knowledge/http";
import {
  findRecordingCamera,
  listSegments,
  recordingsDir,
  recordingKeysFor,
  type RecordingSegment,
} from "@/lib/recordings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/** Segment có start ≤ mốc yêu cầu lớn nhất (fallback: segment sớm nhất). */
function pickSegment(perKey: { segs: RecordingSegment[] }[], start: number): RecordingSegment {
  let best: RecordingSegment | null = null;
  let earliest: RecordingSegment | null = null;
  for (const { segs } of perKey) {
    for (const s of segs) {
      const t = s.start.getTime();
      if (!earliest || t < earliest.start.getTime()) earliest = s;
      if (t <= start && (!best || t > best.start.getTime())) best = s;
    }
  }
  return (best ?? earliest)!;
}

/**
 * `Range: bytes=a-b` → [a, min(b, size-1)]; `a-` → tới hết file; `-n` → n byte
 * cuối. null → dải không phục vụ được (caller trả 416 kèm Content-Range "bytes *").
 */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = RANGE_RE.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number, end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start >= size || start > end) return null;
  return { start, end };
}

/** Stream file segment (nguyên file hoặc dải byte) + audit khi đọc đĩa lỗi giữa chừng. */
function fileStreamResponse(
  filePath: string,
  opts: { status: number; headers: Headers; cameraId: number; file: string; start?: number; end?: number },
): Response {
  const stream = createReadStream(filePath, opts.start === undefined ? undefined : { start: opts.start, end: opts.end });
  stream.on("error", (e) => {
    void audit("recording.play_failed", {
      targetType: "camera",
      targetId: opts.cameraId,
      detail: `file=${opts.file} err=${e.message}`,
    });
  });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: opts.status, headers: opts.headers });
}

/**
 * GET /api/recordings/play?cameraId&start&duration&format&download
 * Phục vụ file segment đã ghi trên đĩa (mediaMTX playback không phát được bằng
 * Chrome — T-1323b). Chọn segment có start ≤ mốc yêu cầu gần nhất rồi stream
 * bằng Range thật: 206 + Content-Range khi client gửi Range, 200 nguyên file
 * khi không, 416 + Content-Range "bytes *" khi dải hỏng.
 */
export async function GET(req: Request) {
  return withTenant("read", async ({ tenantId }) => {
    const u = new URL(req.url);
    const cameraId = queryCameraId(u);
    if (cameraId === undefined) throw new HttpError(400, "CAMERA_REQUIRED", "Thiếu tham số cameraId.");
    const startRaw = u.searchParams.get("start");
    const start = startRaw ? new Date(startRaw) : null;
    if (!start || Number.isNaN(start.getTime()))
      throw new HttpError(400, "INVALID_START", "start phải là thời điểm RFC3339 hợp lệ.");
    // duration giữ validate tương thích (1–86400) nhưng KHÔNG cắt file: segment
    // ghi sẵn ~5 phút, client tự seek/dừng bằng Range.
    const rawDuration = u.searchParams.get("duration");
    const duration = rawDuration === null ? undefined : Number(rawDuration);
    if (duration !== undefined && (!Number.isFinite(duration) || duration < 1 || duration > 86400))
      throw new HttpError(400, "INVALID_DURATION", "duration phải là số giây 1–86400.");
    const format = u.searchParams.get("format");
    if (format !== null && !["mp4", "fmp4"].includes(format))
      throw new HttpError(400, "INVALID_FORMAT", "format chỉ nhận mp4 hoặc fmp4.");

    const cam = await findRecordingCamera(tenantId, cameraId);
    if (!cam) return denied("camera", cameraId);
    const perKey = await Promise.all(recordingKeysFor(cam).map(async (k) => ({ segs: await listSegments(k) })));
    if (!perKey.some((x) => x.segs.length)) return problem(404, "Chưa có bản ghi nào cho camera này.");

    // Chỉ dùng segment.file do listSegments trả về ("<key>/<tên đã qua
    // SEGMENT_RE>") — không nhận đường dẫn nào từ query nên không có traversal.
    const seg = pickSegment(perKey, start.getTime());
    const filePath = join(recordingsDir(), seg.file);
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) {
      await audit("recording.play_failed", { targetType: "camera", targetId: cameraId, detail: `file=${seg.file}` });
      return problem(404, "Không có bản ghi ở mốc thời gian này.");
    }

    const headers = new Headers({
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    });
    if (u.searchParams.get("download") === "1") {
      const safeName = cam.name.replace(/[^A-Za-z0-9._ -]/g, "").trim() || "camera";
      const stamp = start.toISOString().replace(/[:.]/g, "-");
      headers.set("Content-Disposition", `attachment; filename="${safeName}-${stamp}.mp4"`);
    }

    const range = req.headers.get("range");
    if (!range) {
      headers.set("Content-Length", String(st.size));
      return fileStreamResponse(filePath, { status: 200, headers, cameraId, file: seg.file });
    }
    const r = parseRange(range, st.size);
    if (!r) {
      headers.set("Content-Range", `bytes */${st.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${r.start}-${r.end}/${st.size}`);
    headers.set("Content-Length", String(r.end - r.start + 1));
    return fileStreamResponse(filePath, { status: 206, headers, cameraId, file: seg.file, start: r.start, end: r.end });
  });
}
