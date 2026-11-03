import { audit, problem } from "@/lib/audit";
import { HttpError } from "@/lib/http-guard";
import { denied, queryCameraId, withTenant } from "@/lib/knowledge/http";
import {
  findRecordingCamera,
  listSegments,
  playbackBase,
  recordingKeysFor,
  type RecordingSegment,
} from "@/lib/recordings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const UPSTREAM_CONNECT_MS = 8000;

/** Key sở hữu segment gần nhất ≤ start (fallback: key của segment sớm nhất). */
function pickKey(perKey: { k: string; segs: RecordingSegment[] }[], start: number): string {
  let best: { k: string; t: number } | null = null;
  let earliest: { k: string; t: number } | null = null;
  for (const { k, segs } of perKey) {
    for (const s of segs) {
      const t = s.start.getTime();
      if (!earliest || t < earliest.t) earliest = { k, t };
      if (t <= start && (!best || t > best.t)) best = { k, t };
    }
  }
  return (best ?? earliest)!.k;
}

/**
 * GET /api/recordings/play?cameraId&start&duration&format&download
 * Proxy tới mediaMTX playback `GET /get?path&start&duration&format`. Tua bằng
 * tham số start (mỗi lần tua = request mới — không buffer file trên server).
 * Header Range của client được chuyển tiếp: upstream trả 206 thì trả 206,
 * còn upstream chỉ stream 200 (mediaMTX hiện tại) thì trả 200 nguyên trạng.
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
    const rawDuration = u.searchParams.get("duration");
    const duration = rawDuration === null ? undefined : Number(rawDuration);
    if (duration !== undefined && (!Number.isFinite(duration) || duration < 1 || duration > 86400))
      throw new HttpError(400, "INVALID_DURATION", "duration phải là số giây 1–86400.");
    const format = u.searchParams.get("format");
    if (format !== null && !["mp4", "fmp4"].includes(format))
      throw new HttpError(400, "INVALID_FORMAT", "format chỉ nhận mp4 hoặc fmp4.");

    const cam = await findRecordingCamera(tenantId, cameraId);
    if (!cam) return denied("camera", cameraId);
    const keys = recordingKeysFor(cam);
    const perKey = await Promise.all(keys.map(async (k) => ({ k, segs: await listSegments(k) })));
    if (!perKey.some((x) => x.segs.length)) return problem(404, "Chưa có bản ghi nào cho camera này.");

    const upstream = new URL(`${playbackBase()}/get`);
    upstream.searchParams.set("path", pickKey(perKey, start.getTime()));
    upstream.searchParams.set("start", start.toISOString());
    if (duration !== undefined) upstream.searchParams.set("duration", String(duration));
    if (format) upstream.searchParams.set("format", format);

    const range = req.headers.get("range");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), UPSTREAM_CONNECT_MS);
    let res: Response;
    try {
      res = await fetch(upstream, {
        signal: ctl.signal,
        cache: "no-store",
        headers: range ? { Range: range } : {},
      });
    } catch {
      return problem(503, "Máy chủ phát lại chưa sẵn sàng", "Playback mediaMTX không phản hồi.");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) {
      await res.body?.cancel();
      return problem(404, "Không có bản ghi ở mốc thời gian này.");
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      await audit("recording.play_failed", { targetType: "camera", targetId: cameraId, detail: `upstream=${res.status}` });
      return problem(502, "Nguồn phát lại trả lỗi", `Playback trả HTTP ${res.status}.`);
    }

    const headers = new Headers();
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (!headers.has("content-type")) headers.set("content-type", "video/mp4");
    headers.set("Cache-Control", "no-store, private");
    headers.set("X-Content-Type-Options", "nosniff");
    if (u.searchParams.get("download") === "1") {
      const safeName = cam.name.replace(/[^A-Za-z0-9._ -]/g, "").trim() || "camera";
      const stamp = start.toISOString().replace(/[:.]/g, "-");
      headers.set("Content-Disposition", `attachment; filename="${safeName}-${stamp}.mp4"`);
    }
    return new Response(res.body, { status: res.status, headers });
  });
}
