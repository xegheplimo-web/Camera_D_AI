import { db } from "@/db";
import { aiServices } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { AiError, type ServiceName, type TaskType } from "./types";
import { serviceStatus } from "./services";

export type { TaskType } from "./types";
export type AdapterState = "not_configured" | "ready" | "busy" | "unavailable";
export type Profile = { task: TaskType; adapter: string; timeoutMs: number; concurrency: number; asyncOnly: boolean };

/**
 * Server-owned task → adapter registry (design doc 20_ §4). The planner decides
 * WHAT to do; this table decides WHERE it runs — model/URL/adapter names never
 * come from Hermes plans or client input.
 */
export const PROFILES: Record<TaskType, Profile> = {
  "data.query":          { task: "data.query",          adapter: "sql",          timeoutMs: 1000,  concurrency: 4, asyncOnly: false },
  "analysis.multi_step": { task: "analysis.multi_step", adapter: "hermes-glm",   timeoutMs: 15000, concurrency: 1, asyncOnly: true },
  "image.describe":      { task: "image.describe",      adapter: "vision",       timeoutMs: 30000, concurrency: 1, asyncOnly: true },
  "video.summarize":     { task: "video.summarize",     adapter: "vision",       timeoutMs: 60000, concurrency: 1, asyncOnly: true },
  "video.search":        { task: "video.search",        adapter: "video-search", timeoutMs: 10000, concurrency: 2, asyncOnly: true },
  "ocr.read":            { task: "ocr.read",            adapter: "ocr",          timeoutMs: 5000,  concurrency: 1, asyncOnly: true },
  "plate.read":          { task: "plate.read",          adapter: "ocr",          timeoutMs: 5000,  concurrency: 1, asyncOnly: true },
  "text.embed":          { task: "text.embed",          adapter: "embed-text",   timeoutMs: 3000,  concurrency: 1, asyncOnly: true },
  "image.embed":         { task: "image.embed",         adapter: "embed-image",  timeoutMs: 3000,  concurrency: 1, asyncOnly: true },
  "speech.stt":          { task: "speech.stt",          adapter: "stt",          timeoutMs: 15000, concurrency: 1, asyncOnly: true },
  "speech.tts":          { task: "speech.tts",          adapter: "tts",          timeoutMs: 10000, concurrency: 1, asyncOnly: true },
  "object.count":        { task: "object.count",        adapter: "detector",     timeoutMs: 1000,  concurrency: 4, asyncOnly: true },
};

export function resolveProfile(task: TaskType): Profile {
  const profile = PROFILES[task];
  if (!profile) throw new AiError("UNKNOWN_TASK", `Không có profile cho loại tác vụ "${String(task)}".`, 400);
  return profile;
}

/** Adapters backed by an OpenAI-compatible service configured via env. */
const SERVICE_ADAPTERS: Record<string, ServiceName> = {
  "hermes-glm": "hermes",
  vision: "vision",
  ocr: "ocr",
  stt: "voice",
  tts: "voice",
};

/**
 * Local adapters and their readiness flag ("cờ local"). SQL-backed adapters are
 * ready today; model-backed local adapters report ready only when their runtime
 * flag is set (PR2/PR3 land the actual workers).
 */
const LOCAL_READY: Record<string, () => boolean> = {
  sql: () => true,
  // Chưa có handler truy xuất video (bậc A chưa triển khai) → không được báo ready.
  "video-search": () => false,
  detector: () => !!process.env.DAI_LOCAL_DETECTOR,
  "embed-text": () => !!process.env.DAI_LOCAL_EMBED_TEXT,
  "embed-image": () => !!process.env.DAI_LOCAL_EMBED_IMAGE,
};

function mapServiceState(state: string): AdapterState {
  switch (state) {
    case "online": return "ready";
    case "cooldown": return "busy";
    case "offline": return "unavailable";
    default: return "busy"; // configured but chưa probe → chưa chứng minh sẵn sàng
  }
}

export async function adapterState(adapter: string): Promise<AdapterState> {
  const service = SERVICE_ADAPTERS[adapter];
  if (service) {
    const status = (await serviceStatus()).find((s) => s.name === service);
    if (!status || !status.configured) return "not_configured";
    return mapServiceState(status.state);
  }
  const ready = LOCAL_READY[adapter];
  if (ready) return ready() ? "ready" : "not_configured";
  return "not_configured";
}

export async function pickAdapter(task: TaskType): Promise<{ profile: Profile; state: AdapterState }> {
  const profile = resolveProfile(task);
  return { profile, state: await adapterState(profile.adapter) };
}

/**
 * Circuit breaker per profile (không theo tên dịch vụ): lỗi của Qwen-VL không
 * được khoá OCR. Reuses ai_services rows keyed `profile:<task>` — no new table.
 * Unlike markService (2-failure threshold), a profile opens on first failure.
 */
export async function markProfile(task: TaskType, ok: boolean, latencyMs: number, code?: string) {
  const now = new Date();
  const name = `profile:${task}`;
  await db.insert(aiServices).values({
    name, state: ok ? "online" : "offline", consecutiveFailures: ok ? 0 : 1,
    checkedAt: now, latencyMs, lastError: ok ? null : code ?? "UNAVAILABLE",
    cooldownUntil: ok ? null : new Date(now.getTime() + 30_000),
  }).onConflictDoUpdate({ target: aiServices.name, set: {
    state: ok ? "online" : "offline", checkedAt: now, latencyMs, lastError: ok ? null : code ?? "UNAVAILABLE",
    consecutiveFailures: ok ? 0 : sql`${aiServices.consecutiveFailures} + 1`,
    cooldownUntil: ok ? null : sql`now() + interval '30 seconds'`,
  } });
}

/** true = profile đang dùng được (breaker đóng). Tên hàm phản ánh quyền được gọi. */
export async function profileAvailable(task: TaskType): Promise<boolean> {
  const [row] = await db.select().from(aiServices).where(eq(aiServices.name, `profile:${task}`)).limit(1);
  return !(row?.cooldownUntil && row.cooldownUntil > new Date());
}
