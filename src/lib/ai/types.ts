import type { AnswerPayload } from "@/db/schema";

export type JobKind = "report" | "extract" | "asset.index";
export type JobState = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
export type JobRoute = "hermes" | "worker" | "fallback";
export type ToolName = "memory.summary" | "memory.events" | "vision.extract" | "ocr.extract";
export type ServiceName = "hermes" | "vision" | "ocr" | "voice";
export type Roi = { x: number; y: number; w: number; h: number };
export type JobInput = {
  question?: string;
  inputMode?: "text" | "voice";
  extractionId?: number;
  assetId?: number;
  note?: string;
  taskType?: string;
  roi?: Roi | null;
  // Frozen at admission; retries never silently switch data scope or consent.
  demoMode: boolean;
  allowRemote: boolean;
  asOf: string;
};
export type Plan = { tools: ToolName[]; origin: "hermes" | "gateway" };

/** Server-owned task registry; the planner never picks a model/adapter itself. */
export type TaskType = "data.query" | "analysis.multi_step" | "image.describe" | "video.summarize"
  | "video.search" | "ocr.read" | "plate.read" | "text.embed" | "image.embed"
  | "speech.stt" | "speech.tts" | "object.count";
/** Declared data path of a service: never inferred from the endpoint host alone. */
export type Egress = "local" | "remote";
export type Step = {
  id: string;
  worker: string;
  label: string;
  state: "waiting" | "running" | "succeeded" | "failed" | "skipped";
  note?: string;
  startedAt?: string;
  durationMs?: number;
};
export type JobResult = { answer?: AnswerPayload; extractionId?: number; assistantId?: number };
export type JobView = {
  id: string;
  kind: JobKind;
  state: JobState;
  route: JobRoute;
  title: string;
  progress: number;
  steps: Step[];
  attempts: number;
  errorCode: string | null;
  error: string | null;
  result: JobResult | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  requesterDevice: string;
  requester: string;
};
export type RouteDecision = { path: "fast" | "orchestrated"; reason: string; task?: TaskType };
export const TERMINAL: JobState[] = ["succeeded", "partial", "failed", "cancelled"];

export class AiError extends Error {
  constructor(public code: string, message: string, public httpStatus = 503) {
    super(message);
    this.name = "AiError";
  }
}

export function errorInfo(e: unknown) {
  if (e instanceof AiError) return { code: e.code, message: e.message, status: e.httpStatus };
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"))
    return { code: "TIMEOUT", message: "Dịch vụ xử lý quá thời gian cho phép. Bạn có thể thử lại.", status: 504 };
  return { code: "PROCESSING_FAILED", message: "Không xử lý được tác vụ. Dữ liệu gốc vẫn được giữ nguyên.", status: 503 };
}
