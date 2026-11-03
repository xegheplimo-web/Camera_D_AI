/**
 * T-1340 — control-plane recorder mediaMTX (server-only).
 *
 * Trước card này app chỉ ĐỌC mediaMTX (`/v3/paths/list` trong health.ts); file
 * này thêm phía ghi: tạo / patch / xoá path qua `/v3/config/paths/*` để bật-tắt
 * ghi 24/7 từ drawer settings thay vì tạo path bằng tay.
 *
 * Mọi hàm trả `RecorderState`, KHÔNG throw ra ngoài: mediaMTX chết ≠ crash route.
 * Riêng `applyRecordPatch` quyết định PATCH settings có được ghi DB hay không —
 * bật record mà recorder không reachable ⇒ `{ok:false, 503}` và `persist()`
 * không được gọi, nên `record_enabled` không bao giờ báo bật giả.
 *
 * Bảo mật: `streamName` bị chặt bởi NAME_RE (chống traversal trong URL API) và
 * lỗi trả về chỉ chứa status/giai đoạn — không kèm `sourceUrl` (có credential).
 */
import { resolve } from "node:path";

export type RecorderState = { reachable: boolean; pathExists: boolean; recording: boolean; error?: string };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;
const TIMEOUT_MS = 3000;
const JSON_HEADERS = { "Content-Type": "application/json" };

/** `keep` = recordDeleteAfter mặc định khi caller không truyền retentionDays (camera_settings mặc định 7 ngày ⇒ "7d"). */
export function recorderConfig(): { api: string; recordingsDir: string; segment: string; keep: string } {
  return {
    api: (process.env.MEDIAMTX_API ?? "http://127.0.0.1:9997").replace(/\/+$/, ""),
    recordingsDir: resolve(process.env.RECORDINGS_DIR || "F:/Camera-D-AI/runtime/recordings"),
    segment: "5m",
    keep: "7d",
  };
}

function nameError(streamName: string): RecorderState | null {
  return NAME_RE.test(streamName) && !streamName.includes("..")
    ? null
    : { reachable: false, pathExists: false, recording: false, error: "tên stream không hợp lệ" };
}

async function call(path: string, init: RequestInit): Promise<{ res: Response | null; error?: string }> {
  try {
    const res = await fetch(`${recorderConfig().api}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    return { res };
  } catch (e) {
    // Không kèm URL request vào lỗi — đường add/patch chứa streamName (không nhạy cảm).
    return { res: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Body bật ghi đúng hợp đồng card: tcp pull, fmp4 segment 5m, part 1s, keep theo retention. */
function recordBody(sourceUrl: string, retentionDays?: number): string {
  const c = recorderConfig();
  return JSON.stringify({
    source: sourceUrl,
    sourceProtocol: "tcp",
    sourceOnDemand: false,
    record: true,
    recordFormat: "fmp4",
    recordSegmentDuration: c.segment,
    recordPartDuration: "1s",
    recordDeleteAfter: retentionDays != null ? `${retentionDays}d` : c.keep,
    recordPath: `${c.recordingsDir}/%path/%Y-%m-%d_%H-%M-%S-%f`,
  });
}

/** 404 = API sống nhưng chưa có path; 200 = đọc record flag thật từ config path. */
export async function recorderState(streamName: string): Promise<RecorderState> {
  const bad = nameError(streamName);
  if (bad) return bad;
  // record là cờ CONFIG — /v3/paths/get là runtime state (ready/readers/tracks…), không có record.
  const { res, error } = await call(`/v3/config/paths/get/${encodeURIComponent(streamName)}`, { method: "GET" });
  if (!res) return { reachable: false, pathExists: false, recording: false, error };
  if (res.status === 404) return { reachable: true, pathExists: false, recording: false };
  if (!res.ok) return { reachable: false, pathExists: false, recording: false, error: `mediaMTX trả ${res.status}` };
  const body = (await res.json().catch(() => null)) as { record?: unknown } | null;
  if (!body || typeof body !== "object")
    return { reachable: false, pathExists: false, recording: false, error: "phản hồi mediaMTX không hợp lệ" };
  return { reachable: true, pathExists: true, recording: body.record === true };
}

/**
 * Bật ghi idempotent: POST add trước; 400 "already exists" ⇒ PATCH cập nhật toàn
 * bộ cấu hình ghi (source/retention có thể đã đổi). Kết thúc bằng GET để trả
 * trạng thái thật thay vì tin lời hứa của write.
 */
export async function ensureRecordingPath(input: {
  streamName: string;
  sourceUrl: string;
  retentionDays?: number;
}): Promise<RecorderState> {
  const bad = nameError(input.streamName);
  if (bad) return bad;
  // Không bao giờ đặt record:true cho path có source rỗng.
  if (typeof input.sourceUrl !== "string" || !input.sourceUrl.trim())
    return { reachable: false, pathExists: false, recording: false, error: "nguồn camera rỗng — từ chối bật ghi" };
  const name = encodeURIComponent(input.streamName);
  const body = recordBody(input.sourceUrl.trim(), input.retentionDays);
  const add = await call(`/v3/config/paths/add/${name}`, { method: "POST", headers: JSON_HEADERS, body });
  if (!add.res) return { reachable: false, pathExists: false, recording: false, error: add.error };
  if (add.res.ok) return recorderState(input.streamName);
  if (add.res.status !== 400)
    return { reachable: add.res.status < 500, pathExists: false, recording: false, error: `mediaMTX add trả ${add.res.status}` };
  const patch = await call(`/v3/config/paths/patch/${name}`, { method: "PATCH", headers: JSON_HEADERS, body });
  if (!patch.res) return { reachable: false, pathExists: false, recording: false, error: patch.error };
  if (!patch.res.ok)
    return { reachable: patch.res.status < 500, pathExists: true, recording: false, error: `mediaMTX patch trả ${patch.res.status}` };
  return recorderState(input.streamName);
}

/**
 * Tắt ghi nhưng giữ path. PATCH thất bại ⇒ báo recording:true (fail-safe — khả
 * năng vẫn đang ghi). PATCH ok thì đọc lại config trả recording thật: vẫn
 * record:true ⇒ báo lỗi, không tắt giả.
 */
export async function disableRecording(streamName: string): Promise<RecorderState> {
  const bad = nameError(streamName);
  if (bad) return bad;
  const { res, error } = await call(`/v3/config/paths/patch/${encodeURIComponent(streamName)}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ record: false }),
  });
  if (!res) return { reachable: false, pathExists: false, recording: true, error };
  if (res.status === 404) return { reachable: true, pathExists: false, recording: false };
  if (!res.ok)
    return { reachable: res.status < 500, pathExists: true, recording: true, error: `mediaMTX patch trả ${res.status}` };
  const st = await recorderState(streamName);
  // PATCH ok nhưng không đọc lại được config ⇒ fail-safe: có thể vẫn đang ghi.
  if (!st.reachable) return { reachable: false, pathExists: true, recording: true, error: st.error };
  return st.recording ? { ...st, error: "mediaMTX vẫn báo record:true sau patch tắt" } : st;
}

/** Xoá hẳn path khi xoá camera; 404 = không có gì để gỡ, coi như thành công. */
export async function removeRecordingPath(streamName: string): Promise<RecorderState> {
  const bad = nameError(streamName);
  if (bad) return bad;
  const { res, error } = await call(`/v3/config/paths/delete/${encodeURIComponent(streamName)}`, { method: "DELETE" });
  if (!res) return { reachable: false, pathExists: false, recording: false, error };
  if (!res.ok && res.status !== 404)
    return { reachable: res.status < 500, pathExists: true, recording: false, error: `mediaMTX delete trả ${res.status}` };
  return { reachable: true, pathExists: false, recording: false };
}

export type RecordPatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; title: string; detail?: string };

/**
 * Seam cho PATCH /settings khi body đụng `recordEnabled`:
 *  - Bật: ensure path TRƯỚC persist — recorder không reachable ⇒ 503 và
 *    persist() không chạy (DB giữ nguyên record_enabled, không báo bật giả).
 *  - Tắt: persist trước rồi best-effort PATCH record:false — DB là ý định
 *    người dùng; chỉ dừng recorder khi bản ghi đã commit (tránh lệch pha 409).
 */
export async function applyRecordPatch<T extends { ok: boolean }>(input: {
  enable: boolean;
  current: boolean;
  streamName: string;
  sourceUrl: string | null;
  retentionDays: number;
  persist: () => Promise<T>;
}): Promise<RecordPatchResult<T>> {
  if (input.enable) {
    if (typeof input.sourceUrl !== "string" || !input.sourceUrl.trim())
      return { ok: false, status: 400, title: "Camera chưa có nguồn RTSP để ghi hình", detail: "record_requires_rtsp" };
    const st = await ensureRecordingPath({
      streamName: input.streamName,
      sourceUrl: input.sourceUrl,
      retentionDays: input.retentionDays,
    });
    if (!st.reachable || !st.recording)
      return { ok: false, status: 503, title: "Không bật được ghi hình", detail: st.error ?? "recorder không sẵn sàng" };
  }
  const value = await input.persist();
  if (!input.enable && input.current && value.ok) await disableRecording(input.streamName);
  return { ok: true, value };
}
