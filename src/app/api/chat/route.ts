import { after } from "next/server";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { answerQuestion } from "@/lib/qa";
import { ensureSeed } from "@/lib/seed";
import { audit } from "@/lib/audit";
import { authorize } from "@/lib/auth-server";
import { tenantIdOf } from "@/lib/knowledge/tenant";
import { getSettings } from "@/lib/settings";
import { routeQuestion } from "@/lib/ai/routing";
import { dispatchJobs, enqueueJob, jobView } from "@/lib/ai/jobs";
import { aiProblem, readJson, requestKey, throttle } from "@/lib/ai/http";
import { AiError } from "@/lib/ai/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  const rows = await db.select().from(messages).where(eq(messages.userId, auth.session.sub)).orderBy(desc(messages.id)).limit(40);
  return Response.json(rows.reverse());
}

export async function POST(req: Request) {
  const auth = await authorize("ask");
  if (auth.response) return auth.response;
  try {
    throttle(`chat:${auth.session.sub}`);
    await ensureSeed();
    const b = await readJson(req);
    const question = typeof b.question === "string" ? b.question.trim() : "";
    if (!question || question.length > 1000) throw new AiError("INVALID_QUESTION", "Nhập câu hỏi từ 1 đến 1.000 ký tự.", 400);
    const key = `chat:${requestKey(req, b)}`;
    const inputMode = b.inputMode === "voice" ? "voice" : "text";
    const session = auth.session;
    const tenantId = await tenantIdOf(session);
    const t0 = Date.now();
    const route = routeQuestion(question);
    const previous = await db.select().from(messages).where(and(eq(messages.userId, session.sub), eq(messages.requestKey, key)));
    const oldUser = previous.find((m) => m.role === "user");
    if (oldUser && oldUser.text !== question) throw new AiError("IDEMPOTENCY_CONFLICT", "Mã yêu cầu đã được dùng cho câu hỏi khác.", 409);
    const oldAnswer = previous.find((m) => m.role === "assistant");
    if (oldAnswer) return Response.json({ user: oldUser, assistant: oldAnswer, duplicate: true, latencyMs: Date.now() - t0, speech: { target: "requester_device", device: session.device } });

    if (route.path === "orchestrated") {
      const settings = await getSettings();
      const { job, duplicate } = await enqueueJob("report", {
        question, inputMode, demoMode: settings.demoMode, allowRemote: settings.remoteProcessingAllowed,
        asOf: new Date().toISOString(),
      }, session, key);
      const [user] = await db.select().from(messages).where(and(eq(messages.userId, session.sub), eq(messages.requestKey, key), eq(messages.role, "user"))).limit(1);
      after(() => dispatchJobs());
      return Response.json({ accepted: true, user, job: jobView(job), duplicate, routing: route, speech: { target: "requester_device", device: session.device } }, { status: 202 });
    }

    // The fast path has no Hermes/network dependency, health probe or heavy model call.
    const answer = await answerQuestion(question, session);
    answer.execution = { path: "fast", durationMs: Date.now() - t0, reason: route.reason };
    const saved = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(34215, ${session.sub})`);
      const [prior] = await tx.select({ text: messages.text }).from(messages).where(and(eq(messages.userId, session.sub), eq(messages.requestKey, key), eq(messages.role, "user"))).limit(1);
      if (prior && prior.text !== question) throw new AiError("IDEMPOTENCY_CONFLICT", "Mã yêu cầu đã được dùng cho câu hỏi khác.", 409);
      await tx.insert(messages).values({ tenantId, role: "user", text: question, userId: session.sub, device: session.device, inputMode, requestKey: key }).onConflictDoNothing();
      await tx.insert(messages).values({ tenantId, role: "assistant", text: answer.short, answer, userId: session.sub, device: session.device, inputMode, requestKey: key }).onConflictDoNothing();
      return tx.select().from(messages).where(and(eq(messages.userId, session.sub), eq(messages.requestKey, key)));
    });
    await audit("chat.fast", { targetType: "message", targetId: saved.find((m) => m.role === "user")?.id, detail: "Gateway → Memory/SQL; Hermes bypassed" });
    return Response.json({ user: saved.find((m) => m.role === "user"), assistant: saved.find((m) => m.role === "assistant"), routing: route,
      latencyMs: Date.now() - t0, speech: { target: "requester_device", device: session.device, remotePlayback: false } });
  } catch (e) { return aiProblem(e); }
}

export async function DELETE() {
  const auth = await authorize("ask");
  if (auth.response) return auth.response;
  await db.delete(messages).where(eq(messages.userId, auth.session.sub));
  await audit("chat.clear_own");
  return Response.json({ ok: true });
}
