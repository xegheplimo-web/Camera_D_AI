import { db } from "@/db";
import { aiJobs, messages } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { authorize } from "@/lib/auth-server";
import { getSettings } from "@/lib/settings";
import { serviceFetch, serviceStatus } from "@/lib/ai/services";
import { detectorStatus } from "@/lib/camera/detector";
import { aiProblem, readJson, throttle } from "@/lib/ai/http";
import { AiError, errorInfo, type ServiceName } from "@/lib/ai/types";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const OWNER_ONLY = () => Response.json({ type: "about:blank", title: "Hạ tầng điều phối chỉ hiển thị cho chủ hệ thống.", status: 403 }, { status: 403 });

export async function GET() {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  if (auth.session.role !== "owner") return OWNER_ONLY();
  const settings = await getSettings();
  const stats = await db.select({ state: aiJobs.state, count: sql<number>`count(*)::int` }).from(aiJobs).where(eq(aiJobs.userId, auth.session.sub)).groupBy(aiJobs.state);
  const [fast] = await db.select({ count: sql<number>`count(*)::int` }).from(messages).where(and(eq(messages.userId, auth.session.sub), eq(messages.role, "assistant"), sql`${messages.answer}->'execution'->>'path' = 'fast'`));
  return Response.json({ services: await serviceStatus(), settings: { hermesEnabled: settings.hermesEnabled, remoteProcessingAllowed: settings.remoteProcessingAllowed },
    fastPath: { state: "online", worker: "Memory / SQL", count: fast.count }, stats,
    canManage: auth.session.role === "owner" || auth.session.role === "operator", isOwner: auth.session.role === "owner",
    detector: await detectorStatus(),
    dispatchMode: process.env.DAI_DISPATCH_TOKEN ? "request-driven + dispatcher endpoint configured" : "request-driven (next.after + polling recovery)",
    maxConcurrency: 2, maxAttempts: 3, modelDownloadsOnClient: false,
  });
}
export async function POST(req: Request) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  if (auth.session.role !== "owner") return OWNER_ONLY();
  try {
    throttle(`ai-probe:${auth.session.sub}`, 6);
    const b = await readJson(req);
    if (b.action !== "probe" || !["hermes", "vision", "ocr", "voice"].includes(String(b.service))) throw new AiError("INVALID_SERVICE", "Chọn một dịch vụ hợp lệ để kiểm tra.", 400);
    const service = b.service as ServiceName;
    const settings = await getSettings();
    let result;
    try {
      const response = await serviceFetch(service, "models", {}, { probe: true, allowRemote: settings.remoteProcessingAllowed });
      await response.body?.cancel();
      result = { ok: true, message: "Endpoint /v1/models trả HTTP thành công. Chưa phải benchmark xử lý AI." };
    } catch (e) { result = { ok: false, ...errorInfo(e) }; }
    await audit("ai.service.probe", { targetType: "service", targetId: service, detail: result.ok ? "ok" : "failed" });
    return Response.json({ ...result, services: await serviceStatus() });
  } catch (e) { return aiProblem(e); }
}
