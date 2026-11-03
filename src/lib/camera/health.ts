/**
 * T-1319 — probe trạng thái kết nối THẬT của camera.
 * RTSP: mediaMTX /v3/paths/list (name === streamName, ready && online).
 * Webcam: phát trên trình duyệt → server không probe được (client tự quyết).
 * Demo: nguồn mô phỏng → không có kết nối vật lý.
 * Server-only: gọi mediaMTX qua loopback, không serialize credentials.
 */
import { decryptSource } from "./stream";
import type { ConnectionState } from "./status";

export type SourceKind = "physical" | "webcam" | "simulated";
export type EffectiveStatus = ConnectionState | "client" | "simulated";

const PROBE_TIMEOUT_MS = 1500;
const CACHE_TTL_MS = 5000;

function mediamtxApi(): string {
  return (process.env.MEDIAMTX_API ?? "http://127.0.0.1:9997").replace(/\/+$/, "");
}

// Cache trong process: Map<streamName, {state, at}> — tránh gọi mediaMTX mỗi request.
const probeCache = new Map<string, { state: ConnectionState; at: number }>();

/** Xoá cache probe — chỉ dùng cho test. */
export function clearProbeCache(): void {
  probeCache.clear();
}

/**
 * online  : item `name === streamName` tồn tại và ready === true && online === true
 * offline : API trả lời được nhưng item không tồn tại hoặc chưa ready/online
 * unknown : không gọi được mediaMTX (lỗi mạng, timeout, HTTP không 200)
 */
export async function probeRtsp(streamName: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ConnectionState> {
  const hit = probeCache.get(streamName);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.state;
  let state: ConnectionState;
  // AbortController + clearTimeout (không dùng AbortSignal.timeout) để không để lại timer
  // treo khi test/probe kết thúc sớm — timer treo làm node:test huỷ subtest trên CI.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${mediamtxApi()}/v3/paths/list`, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) {
      state = "unknown";
    } else {
      const body = (await res.json().catch(() => null)) as { items?: { name?: unknown; ready?: unknown; online?: unknown }[] } | null;
      const item = body?.items?.find((p) => p?.name === streamName);
      state = item && item.ready === true && item.online === true ? "online" : "offline";
    }
  } catch {
    state = "unknown";
  } finally {
    clearTimeout(timer);
  }
  probeCache.set(streamName, { state, at: Date.now() });
  return state;
}

/**
 * Tên path mediaMTX tương ứng với camera RTSP. App đăng ký stream vào go2rtc
 * dưới tên `dai_cam_<id>` (cột stream_name), còn path mediaMTX mang tên là
 * basename của URL nguồn RTSP (vd. rtsp://<ip>:8554/cam → "cam"). Thử cả hai.
 */
function rtspProbeNames(cam: { streamName?: string | null; sourceCiphertext?: string | null }): string[] {
  const names = new Set<string>();
  if (cam.streamName) names.add(cam.streamName);
  if (cam.sourceCiphertext) {
    try {
      const base = new URL(decryptSource(cam.sourceCiphertext)).pathname.split("/").filter(Boolean).pop();
      if (base) names.add(base);
    } catch { /* thiếu CAMERA_CREDENTIAL_KEY hoặc bản ghi hỏng → chỉ còn streamName */ }
  }
  return [...names];
}

/**
 * Trạng thái kết nối hiệu lực của camera:
 *   webcam → "client"    (trạng thái thật nằm ở trình duyệt, server không thấy)
 *   demo   → "simulated" (nguồn mô phỏng, không có kết nối vật lý)
 *   rtsp   → probeRtsp   (mediaMTX là nguồn sự thật)
 * Nhiều tên candidate: online thắng; không online thì unknown > offline.
 */
export async function effectiveStatus(cam: { sourceType: string; streamName?: string | null; sourceCiphertext?: string | null }): Promise<EffectiveStatus> {
  if (cam.sourceType === "webcam") return "client";
  if (cam.sourceType === "demo") return "simulated";
  const names = rtspProbeNames(cam);
  if (!names.length) return "offline";
  let unknown = false;
  for (const name of names) {
    const s = await probeRtsp(name);
    if (s === "online") return "online";
    if (s === "unknown") unknown = true;
  }
  return unknown ? "unknown" : "offline";
}

/** Nguồn dữ liệu của camera, phục vụ KPI/label — tách khỏi trạng thái kết nối. */
export function sourceKind(sourceType: string): SourceKind {
  if (sourceType === "rtsp") return "physical";
  if (sourceType === "webcam") return "webcam";
  return "simulated";
}
