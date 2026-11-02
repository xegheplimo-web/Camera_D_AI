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

/** Base URL của go2rtc API (loopback-only) cho các consumer server-side khác (detector). */
export function go2rtcBase(): string {
  return gateway();
}

export async function ensureGo2rtcStream(streamName: string, source: string): Promise<void> {
  if (!/^dai_cam_[0-9]+$/.test(streamName)) throw new Error("Tên stream không hợp lệ");
  validateCameraUrl(source);
  const q = new URLSearchParams({ name: streamName });
  q.append("src", source);
  // go2rtc không tự transcode: /api/stream.mjpeg cần producer xuất JPEG, nên đăng ký
  // thêm nhánh ffmpeg đọc chính stream này (một kết nối RTSP tới camera, fan-out tại chỗ).
  q.append("src", `ffmpeg:${streamName}#video=mjpeg`);
  const abort = AbortSignal.timeout(5000);
  const res = await fetch(`${gateway()}/api/streams?${q}`, { method: "PUT", signal: abort, cache: "no-store" });
  if (!res.ok) throw new Error(`go2rtc từ chối kết nối (${res.status})`);
}

/** Gỡ stream khỏi go2rtc khi xoá camera; gọi best-effort — go2rtc chết không chặn xoá DB. */
export async function removeGo2rtcStream(streamName: string): Promise<void> {
  if (!/^dai_cam_[0-9]+$/.test(streamName)) throw new Error("Tên stream không hợp lệ");
  const q = new URLSearchParams({ name: streamName });
  q.append("src", streamName); // go2rtc bản cũ xoá theo src, bản mới theo name — gửi cả hai.
  const res = await fetch(`${gateway()}/api/streams?${q}`, { method: "DELETE", signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!res.ok) throw new Error(`go2rtc từ chối xoá stream (${res.status})`);
}

function streamTimeout(env: string | undefined, fallback: number, min: number): number {
  const parsed = Number(env);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}

export async function getMjpegStream(streamName: string): Promise<Response> {
  if (!/^dai_cam_[0-9]+$/.test(streamName)) throw new Error("Tên stream không hợp lệ");
  const connectMs = streamTimeout(process.env.GO2RTC_STREAM_CONNECT_MS, 10_000, 500);
  const idleMs = streamTimeout(process.env.GO2RTC_STREAM_IDLE_MS, 15_000, 1_000);
  const abort = new AbortController();
  // Timeout chỉ bọc phần thiết lập (tới khi có response headers); luồng sống không
  // bị cắt theo đồng hồ — nó chỉ chết khi upstream im quá idleMs hoặc client ngắt.
  const connectTimer = setTimeout(() => abort.abort(new Error(`go2rtc không phản hồi trong ${connectMs}ms`)), connectMs);
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const startMs = Date.now();
  let upstream!: Response;
  try {
    for (;;) {
      upstream = await fetch(`${gateway()}/api/stream.mjpeg?${new URLSearchParams({ src: streamName })}`, {
        signal: abort.signal, cache: "no-store",
      });
      if ((upstream.status === 502 || upstream.status === 503) && Date.now() - startMs < connectMs) {
        // Producer go2rtc đang cold-boot (đi disconnect dài / nguồn vừa quay lại):
        // nhả body lỗi và retry trong budget connect; nguồn chết thật vẫn 502/503 fail-closed sau budget.
        await upstream.body?.cancel();
        await wait(1000);
        continue;
      }
      break;
    }
  } finally {
    clearTimeout(connectTimer);
  }
  if (!upstream.ok || !upstream.body) return upstream;

  const reader = upstream.body.getReader();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let abandonTimer: ReturnType<typeof setTimeout> | null = null;
  const abandonMs = Math.max(idleMs * 4, 60_000);
  const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  const stopAll = (reason: string) => {
    clearIdle();
    if (abandonTimer) { clearTimeout(abandonTimer); abandonTimer = null; }
    if (!abort.signal.aborted) abort.abort(new Error(reason));
  };
  // Watchdog chỉ canh lúc đang chờ chunk từ upstream — nguồn chết thì go2rtc giữ
  // socket mở nhưng im lặng mãi; backpressure phía dưới không được tính là stall.
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => stopAll(`go2rtc stream im lặng quá ${idleMs}ms`), idleMs);
  };
  // Nếu phía dưới ngừng hút dữ liệu mà không cancel (framework bỏ sót khi client
  // rớt), dọn upstream sau abandonMs thay vì giữ process ffmpeg mồ côi vô hạn.
  const armAbandon = () => {
    if (abandonTimer) clearTimeout(abandonTimer);
    abandonTimer = setTimeout(() => stopAll("consumer của stream bị bỏ lại"), abandonMs);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      armIdle();
      try {
        const { done, value } = await reader.read();
        clearIdle();
        if (controller.desiredSize === null) return; // cancel() thắng race với pull đang chờ
        if (done) {
          if (abandonTimer) { clearTimeout(abandonTimer); abandonTimer = null; }
          controller.close();
        } else {
          controller.enqueue(value);
          armAbandon();
        }
      } catch (error) {
        clearIdle();
        if (abandonTimer) { clearTimeout(abandonTimer); abandonTimer = null; }
        controller.error(error);
      }
    },
    async cancel(reason) {
      stopAll(reason instanceof Error ? reason.message : "client ngắt kết nối");
      try { await reader.cancel(reason); } catch { /* upstream đã tự đóng */ }
    },
  });
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
}
