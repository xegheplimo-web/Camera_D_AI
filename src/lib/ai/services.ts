import { db } from "@/db";
import { aiServices } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { getSettings } from "@/lib/settings";
import { AiError, type Egress, type ServiceName } from "./types";

type ServiceConfig = { base: URL; key: string; model: string; remote: boolean; egress: Egress };
const PREFIX: Record<ServiceName, string> = { hermes: "HERMES", vision: "DAI_VISION", ocr: "DAI_OCR", voice: "DAI_VOICE" };
export const SERVICE_LABELS: Record<ServiceName, string> = { hermes: "Trợ lý AI", vision: "Nhận diện hình ảnh", ocr: "Nhận dạng văn bản", voice: "Giọng nói AI" };

function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "::1"].includes(h) || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true; // tailnet
  return h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".ts.net") || (!h.includes(".") && !h.includes(":")) || /^(fc|fd)[0-9a-f]{2}:/.test(h);
}

/** Endpoints are deployment configuration, never accepted from a browser or a Hermes plan. */
export function serviceConfig(name: ServiceName): ServiceConfig | null {
  const prefix = PREFIX[name];
  const raw = process.env[`${prefix}_BASE_URL`]?.trim();
  if (!raw) return null;
  let base: URL;
  try { base = new URL(raw); } catch { throw new AiError("INVALID_CONFIG", `${SERVICE_LABELS[name]}: địa chỉ cấu hình không hợp lệ.`); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new AiError("INVALID_CONFIG", `${SERVICE_LABELS[name]}: chỉ chấp nhận HTTP(S), không chứa mật khẩu/query trong URL.`);
  // Egress is a server declaration, never inferred from the host: a loopback
  // bridge can forward to the cloud. Undeclared/invalid => remote (fail-safe).
  const declaredEgress = process.env[`${prefix}_EGRESS`]?.trim().toLowerCase();
  const egress: Egress = declaredEgress === "local" ? "local" : "remote";
  const outsideLan = !privateHost(base.hostname);
  if (outsideLan && base.protocol !== "https:") throw new AiError("TLS_REQUIRED", "Dịch vụ ngoài mạng riêng phải dùng HTTPS.");
  const remote = egress === "remote" || outsideLan;
  let path = base.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/v1")) path += "/v1";
  base.pathname = path + "/";
  const key = process.env[`${prefix}_API_KEY`]?.trim() ?? "";
  // Key là auth của hop vận chuyển: bắt buộc với hermes hoặc endpoint ngoài LAN.
  // Một bridge loopback tự giữ key upstream — không bắt app phải có key (consent vẫn chặn theo egress).
  const needsKey = name === "hermes" || outsideLan;
  if (needsKey && !key) throw new AiError("MISSING_API_KEY", `${SERVICE_LABELS[name]} chưa có API key phía máy chủ.`);
  const model = process.env[`${prefix}_MODEL`]?.trim() ?? (name === "hermes" ? "hermes-agent" : "");
  if (name !== "hermes" && name !== "voice" && !model) throw new AiError("MISSING_MODEL", `${SERVICE_LABELS[name]} chưa cấu hình tên model.`);
  return { base, key, model, remote, egress };
}

export async function markService(name: ServiceName, ok: boolean, latencyMs: number, code?: string) {
  const now = new Date();
  await db.insert(aiServices).values({
    name, state: ok ? "online" : "offline", consecutiveFailures: ok ? 0 : 1,
    checkedAt: now, latencyMs, lastError: ok ? null : code ?? "UNAVAILABLE", cooldownUntil: null,
  }).onConflictDoUpdate({ target: aiServices.name, set: {
    state: ok ? "online" : "offline", checkedAt: now, latencyMs, lastError: ok ? null : code ?? "UNAVAILABLE",
    consecutiveFailures: ok ? 0 : sql`${aiServices.consecutiveFailures} + 1`,
    cooldownUntil: ok ? null : sql`case when ${aiServices.consecutiveFailures} >= 1 then now() + interval '30 seconds' else null end`,
  } });
}

export function resolveAiTimeout(envValue?: string): number {
  return Math.min(60000, Math.max(1000, Number(envValue) || 15000));
}

/** Caller cancellation + bounded upstream request. Never redirects Bearer credentials. */
export async function serviceFetch(name: ServiceName, path: string, init: RequestInit = {}, options: { signal?: AbortSignal; allowRemote?: boolean; probe?: boolean } = {}) {
  const c = serviceConfig(name);
  if (!c) throw new AiError("NOT_CONFIGURED", `${SERVICE_LABELS[name]} chưa được cấu hình trên máy chủ.`);
  const settings = await getSettings();
  if (name === "hermes" && !settings.hermesEnabled) throw new AiError("HERMES_DISABLED", "Trợ lý AI đang được tạm dừng; dịch vụ AI vẫn xử lý đường nhanh.");
  if (c.remote && (!settings.remoteProcessingAllowed || options.allowRemote !== true))
    throw new AiError("CONSENT_REQUIRED", "Chưa cho phép gửi dữ liệu đến dịch vụ AI ngoài mạng riêng.", 403);
  const [state] = await db.select().from(aiServices).where(eq(aiServices.name, name)).limit(1);
  if (!options.probe && state?.cooldownUntil && state.cooldownUntil > new Date())
    throw new AiError("CIRCUIT_OPEN", `${SERVICE_LABELS[name]} đang tạm nghỉ 30 giây sau các lỗi kết nối. Dịch vụ AI sẽ dùng phương án dự phòng.`);
  const timeout = resolveAiTimeout(process.env.DAI_AI_TIMEOUT_MS);
  const signals = [AbortSignal.timeout(options.probe ? Math.min(timeout, 4000) : timeout), ...(options.signal ? [options.signal] : [])];
  const start = Date.now();
  try {
    const headers = new Headers(init.headers);
    if (c.key) headers.set("Authorization", `Bearer ${c.key}`);
    const r = await fetch(new URL(path.replace(/^\//, ""), c.base), { ...init, headers, redirect: "error", cache: "no-store", signal: AbortSignal.any(signals) });
    if (!r.ok) {
      await r.body?.cancel();
      throw new AiError(r.status === 429 ? "UPSTREAM_BUSY" : "UPSTREAM_HTTP", `${SERVICE_LABELS[name]} trả lỗi ${r.status}. Không có kết quả nào được coi là đã xác minh.`, r.status === 429 ? 429 : 503);
    }
    await markService(name, true, Date.now() - start);
    return r;
  } catch (e) {
    if (options.signal?.aborted && (options.signal.reason as Error | undefined)?.name !== "TimeoutError")
      throw new AiError("CANCELLED", "Đã hủy yêu cầu tại dịch vụ AI; không ghi nhận đây là lỗi kết nối dịch vụ.", 409);
    const code = e instanceof AiError ? e.code : e instanceof Error && ["AbortError", "TimeoutError"].includes(e.name) ? "TIMEOUT" : "UNREACHABLE";
    await markService(name, false, Date.now() - start, code);
    if (options.signal?.aborted) throw new AiError("CANCELLED", "Đã hủy tác vụ.", 409);
    if (e instanceof AiError) throw e;
    throw new AiError(code, `${SERVICE_LABELS[name]} ${code === "TIMEOUT" ? "phản hồi quá thời gian" : "không kết nối được"}.`);
  }
}

export async function boundedJsonValue(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AiError("INVALID_RESPONSE", "Dịch vụ không trả dữ liệu.");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new AiError("RESPONSE_TOO_LARGE", "Kết quả từ xử lý AI vượt giới hạn 2 MB.");
      parts.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  try {
    const v: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return v;
  } catch { /* no raw response text in logs/errors */ }
  throw new AiError("INVALID_RESPONSE", "Dịch vụ trả dữ liệu không đúng định dạng JSON.");
}

export async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const value = await boundedJsonValue(response);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiError("INVALID_RESPONSE", "Xử lý AI cần trả một JSON object.");
  return value as Record<string, unknown>;
}

export async function completion(name: "hermes" | "vision" | "ocr", messages: unknown[], requestKey: string, options: { signal?: AbortSignal; allowRemote?: boolean }) {
  const config = serviceConfig(name);
  if (!config) throw new AiError("NOT_CONFIGURED", `${SERVICE_LABELS[name]} chưa được cấu hình.`);
  const res = await serviceFetch(name, "chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey, ...(name === "hermes" ? { "X-Hermes-Session-Key": `camera-dai:${requestKey}` } : {}) },
    body: JSON.stringify({ model: config.model, messages, stream: false }),
  }, options);
  const body = await boundedJson(res);
  const choices = body.choices as { message?: { content?: unknown }; finish_reason?: string }[] | undefined;
  const first = choices?.[0];
  if (!first || first.finish_reason !== "stop" || typeof first.message?.content !== "string")
    throw new AiError("INCOMPLETE_RESPONSE", `${SERVICE_LABELS[name]} chưa hoàn thành yêu cầu (không có finish_reason=stop).`);
  return first.message.content;
}

export async function serviceStatus() {
  const rows = await db.select().from(aiServices);
  return (["hermes", "vision", "ocr", "voice"] as ServiceName[]).map((name) => {
    let configured = false, remote = false, egress: Egress = "remote", configError: string | null = null;
    try { const c = serviceConfig(name); configured = !!c; remote = c?.remote ?? false; egress = c?.egress ?? "remote"; }
    catch (e) { configError = e instanceof AiError ? e.message : "Cấu hình chưa hợp lệ"; }
    const row = rows.find((r) => r.name === name);
    return { name, label: SERVICE_LABELS[name], configured, remote, egress, configError,
      state: !configured ? "not_configured" : row?.cooldownUntil && row.cooldownUntil > new Date() ? "cooldown" : row?.state ?? "unknown",
      checkedAt: row?.checkedAt ?? null, latencyMs: row?.latencyMs ?? null, lastError: row?.lastError ?? null,
      stt: name === "voice" && configured && !!process.env.DAI_VOICE_STT_MODEL,
      tts: name === "voice" && configured && !!process.env.DAI_VOICE_TTS_MODEL,
    };
  });
}
