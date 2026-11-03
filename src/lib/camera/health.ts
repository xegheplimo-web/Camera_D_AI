/**
 * T-1319 — probe trạng thái kết nối THẬT của camera.
 *
 * Hai nguồn, mỗi nguồn là "sự thật" cho một đường:
 *   - go2rtc  (/api/frame.jpeg?src=<streamName>) — đường ingest mà detector dùng.
 *   - mediaMTX (/v3/paths/list, name === streamName) — đường record/playback.
 * Online nếu MỘT trong hai đường của **chính camera đó** đang sống.
 *
 * KHÔNG đoán theo basename URL nguồn: nhiều camera cùng trỏ `.../cam` sẽ cùng
 * khớp một path mediaMTX và báo online sai (kiểm 03/11: mediaMTX chỉ có path
 * `cam`, còn go2rtc có dai_cam_34/35/80 → mọi camera đều "online" giả).
 *
 * Webcam: phát trên trình duyệt → server không probe được (client tự quyết).
 * Demo: nguồn mô phỏng → không có kết nối vật lý.
 * Server-only: gọi loopback, không serialize credentials.
 */
import type { ConnectionState } from "./status";

export type SourceKind = "physical" | "webcam" | "simulated";
export type EffectiveStatus = ConnectionState | "client" | "simulated";

const PROBE_TIMEOUT_MS = 1500;
const GO2RTC_TIMEOUT_MS = 3000; // frame đầu có thể phải chờ nhịp keyframe
const CACHE_TTL_MS = 5000;

function mediamtxApi(): string {
  return (process.env.MEDIAMTX_API ?? "http://127.0.0.1:9997").replace(/\/+$/, "");
}

/** null = chưa cấu hình go2rtc ⇒ bỏ qua nguồn này (không coi là offline). */
function go2rtcApi(): string | null {
  const v = process.env.GO2RTC_API?.trim();
  return v ? v.replace(/\/+$/, "") : null;
}

// Cache trong process: tránh gọi API mỗi request. Key tách theo nguồn.
const probeCache = new Map<string, { state: ConnectionState; at: number }>();

/** Xoá cache probe — chỉ dùng cho test. */
export function clearProbeCache(): void {
  probeCache.clear();
}

async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // AbortController + clearTimeout (không dùng AbortSignal.timeout) để không để lại timer
  // treo khi test/probe kết thúc sớm — timer treo làm node:test huỷ subtest trên CI.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fn(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * online  : item `name === streamName` tồn tại và ready === true && online === true
 * offline : API trả lời được nhưng item không tồn tại hoặc chưa ready/online
 * unknown : không gọi được mediaMTX (lỗi mạng, timeout, HTTP không 200)
 */
export async function probeRtsp(streamName: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ConnectionState> {
  const key = `mtx:${streamName}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.state;
  let state: ConnectionState;
  try {
    state = await withTimeout(timeoutMs, async (signal) => {
      const res = await fetch(`${mediamtxApi()}/v3/paths/list`, { signal, cache: "no-store" });
      if (!res.ok) return "unknown" as const;
      const body = (await res.json().catch(() => null)) as { items?: { name?: unknown; ready?: unknown; online?: unknown }[] } | null;
      const item = body?.items?.find((p) => p?.name === streamName);
      return item && item.ready === true && item.online === true ? ("online" as const) : ("offline" as const);
    });
  } catch {
    state = "unknown";
  }
  probeCache.set(key, { state, at: Date.now() });
  return state;
}

/**
 * go2rtc: 200 kèm ảnh = stream của chính camera đó đang chạy.
 * offline: 4xx/5xx (không có stream hoặc không lấy được frame).
 * unknown: không gọi được, hoặc chưa cấu hình GO2RTC_API (không tính là offline).
 */
export async function probeGo2rtc(streamName: string, timeoutMs: number = GO2RTC_TIMEOUT_MS): Promise<ConnectionState> {
  const base = go2rtcApi();
  if (!base) return "unknown";
  const key = `g2:${streamName}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.state;
  let state: ConnectionState;
  try {
    state = await withTimeout(timeoutMs, async (signal) => {
      const res = await fetch(`${base}/api/frame.jpeg?${new URLSearchParams({ src: streamName })}`, { signal, cache: "no-store" });
      await res.body?.cancel();
      return res.ok ? ("online" as const) : ("offline" as const);
    });
  } catch {
    state = "unknown";
  }
  probeCache.set(key, { state, at: Date.now() });
  return state;
}

/**
 * Trạng thái kết nối hiệu lực của camera:
 *   webcam → "client"    (trạng thái thật nằm ở trình duyệt, server không thấy)
 *   demo   → "simulated" (nguồn mô phỏng, không có kết nối vật lý)
 *   rtsp   → go2rtc + mediaMTX theo đúng streamName (online nếu một đường sống)
 * Không có streamName ⇒ offline (không có gì để probe).
 */
export async function effectiveStatus(cam: { sourceType: string; streamName?: string | null }): Promise<EffectiveStatus> {
  if (cam.sourceType === "webcam") return "client";
  if (cam.sourceType === "demo") return "simulated";
  const name = cam.streamName?.trim();
  if (!name) return "offline";
  const [ingest, record] = await Promise.all([probeGo2rtc(name), probeRtsp(name)]);
  if (ingest === "online" || record === "online") return "online";
  if (ingest === "unknown" && record === "unknown") return "unknown";
  return "offline";
}

/** Nguồn dữ liệu của camera, phục vụ KPI/label — tách khỏi trạng thái kết nối. */
export function sourceKind(sourceType: string): SourceKind {
  if (sourceType === "rtsp") return "physical";
  if (sourceType === "webcam") return "webcam";
  return "simulated";
}
