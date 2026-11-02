import { after } from "next/server";
import { db } from "@/db";
import { extractions, messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { authorize } from "@/lib/auth-server";
import { changeJob, dispatchJobs, getJob, jobView } from "@/lib/ai/jobs";
import { aiProblem, readJson, throttle } from "@/lib/ai/http";
import { AiError, TERMINAL } from "@/lib/ai/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const job = await getJob(id, auth.session);
  if (!job) return Response.json({ title: "Không tìm thấy tác vụ trong phạm vi được phép", status: 404 }, { status: 404 });
  let extraction = null, assistant = null;
  if (job.input.extractionId) extraction = (await db.select().from(extractions).where(eq(extractions.id, job.input.extractionId)).limit(1))[0] ?? null;
  if (job.result?.assistantId) assistant = (await db.select().from(messages).where(eq(messages.id, job.result.assistantId)).limit(1))[0] ?? null;
  if (!TERMINAL.includes(job.state)) after(() => dispatchJobs());
  return Response.json({ job: jobView(job), extraction, assistant });
}
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorize("ask");
  if (auth.response) return auth.response;
  try {
    throttle(`job-control:${auth.session.sub}`, 15);
    const { id } = await context.params;
    const job = await getJob(id, auth.session);
    if (!job) throw new AiError("NOT_FOUND", "Không tìm thấy tác vụ trong phạm vi được phép.", 404);
    const body = await readJson(req);
    if (body.action !== "retry" && body.action !== "cancel") throw new AiError("INVALID_ACTION", "Chỉ chấp nhận retry hoặc cancel.", 400);
    if (job.kind === "extract" && auth.session.role === "viewer") throw new AiError("FORBIDDEN", "Cần quyền vận hành để điều khiển tác vụ ảnh.", 403);
    await changeJob(job, body.action, auth.session);
    if (body.action === "retry") after(() => dispatchJobs());
    const updated = await getJob(id, auth.session);
    return Response.json({ job: jobView(updated!) });
  } catch (e) { return aiProblem(e); }
}
