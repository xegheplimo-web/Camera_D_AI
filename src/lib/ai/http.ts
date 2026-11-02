import { AiError, errorInfo } from "./types";
import { problem } from "@/lib/audit";

export async function readJson(req: Request, limit = 24 * 1024): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) throw new AiError("JSON_REQUIRED", "Yêu cầu phải có Content-Type: application/json.", 415);
  const reader = req.body?.getReader();
  if (!reader) throw new AiError("INVALID_BODY", "Nội dung yêu cầu trống.", 400);
  let size = 0;
  const parts: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new AiError("BODY_TOO_LARGE", "Nội dung yêu cầu vượt giới hạn.", 413); }
    parts.push(value);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* bounded parsing, no raw data in errors */ }
  throw new AiError("INVALID_JSON", "JSON không hợp lệ.", 400);
}
export function requestKey(req: Request, body: Record<string, unknown>) {
  const value = req.headers.get("Idempotency-Key") ?? body.requestId ?? crypto.randomUUID();
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{8,120}$/.test(value)) throw new AiError("INVALID_REQUEST_KEY", "Mã yêu cầu phải có 8–120 ký tự chữ/số/gạch ngang.", 400);
  return value;
}
export function aiProblem(error: unknown) {
  const e = errorInfo(error);
  return problem(e.status, e.message, e.code);
}
const hits = new Map<string, { n: number; until: number }>();
export function throttle(key: string, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  if (hits.size > 10000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
  const v = hits.get(key);
  if (!v || v.until < now) { hits.set(key, { n: 1, until: now + windowMs }); return; }
  if (++v.n > limit) throw new AiError("RATE_LIMITED", "Quá nhiều yêu cầu. Vui lòng chờ một chút rồi thử lại.", 429);
}
