/** Server-only go2rtc adapter. Never expose the go2rtc administrative API to browsers. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isPrivateIPv4 } from "./onvif";

export function validateCameraUrl(value: string): URL {
  if (typeof value !== "string" || value.length > 2048 || /[\r\n\x00-\x1f]/.test(value)) throw new Error("Địa chỉ RTSP không hợp lệ");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("Địa chỉ RTSP không hợp lệ"); }
  if (!(["rtsp:", "rtsps:"].includes(parsed.protocol)) || !isPrivateIPv4(parsed.hostname)) {
    throw new Error("Chỉ hỗ trợ RTSP tới địa chỉ IPv4 LAN riêng (10.x, 172.16–31.x, 192.168.x, 169.254.x)");
  }
  if (parsed.port && (+parsed.port < 1 || +parsed.port > 65535)) throw new Error("Cổng camera không hợp lệ");
  if (parsed.hash) throw new Error("RTSP URL không hỗ trợ fragment");
  return parsed;
}

export function maskCameraUrl(value: string): string {
  try { const u = new URL(value); return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`; }
  catch { return "***"; }
}

function encryptionKey(): Buffer {
  const raw = process.env.CAMERA_CREDENTIAL_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error("Thiếu CAMERA_CREDENTIAL_KEY (64 ký tự hex)");
  return Buffer.from(raw, "hex");
}

export function encryptSource(value: string): string {
  validateCameraUrl(value);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${data.toString("base64url")}`;
}

export function decryptSource(value: string): string {
  const [version, iv, tag, data] = value.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Bản ghi camera không hợp lệ");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const result = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  validateCameraUrl(result);
  return result;
}

function gateway(): string {
  // Deliberately not configurable to arbitrary URL to avoid SSRF/misrouted camera credentials.
  const addr = process.env.GO2RTC_HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(addr)) throw new Error("GO2RTC_HOST chỉ được là loopback");
  return `http://${addr === "::1" ? "[::1]" : addr}:1984`;
}

export async function ensureGo2rtcStream(streamName: string, source: string): Promise<void> {
  if (!/^dai_cam_[0-9]+$/.test(streamName)) throw new Error("Tên stream không hợp lệ");
  validateCameraUrl(source);
  const q = new URLSearchParams({ name: streamName, src: source });
  const abort = AbortSignal.timeout(5000);
  const res = await fetch(`${gateway()}/api/streams?${q}`, { method: "PUT", signal: abort, cache: "no-store" });
  if (!res.ok) throw new Error(`go2rtc từ chối kết nối (${res.status})`);
}

export async function getMjpegStream(streamName: string): Promise<Response> {
  if (!/^dai_cam_[0-9]+$/.test(streamName)) throw new Error("Tên stream không hợp lệ");
  return fetch(`${gateway()}/api/stream.mjpeg?${new URLSearchParams({ src: streamName })}`, {
    signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
}
