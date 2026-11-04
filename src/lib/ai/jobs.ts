import { createHash, randomUUID } from "node:crypto";
import { db } from "@/db";
import { aiJobs, assets, extractions, messages, auditLog, sessions, users, type ExtractionResult } from "@/db/schema";
import { and, asc, desc, eq, gt, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { assetReadScope, authorizeResource } from "@/lib/scope";
import { tenantIdOf } from "@/lib/knowledge/tenant";
import type { SessionPayload } from "@/lib/token";
import { AiError, errorInfo, TERMINAL, type JobInput, type JobKind, type JobResult, type JobView, type Step, type ToolName } from "./types";
import { requiredTools } from "./routing";
import { answerBasedOnDemo } from "@/lib/chat-demo";
import { hermesPlan } from "./hermes";
import { summaryWorker, evidenceWorker, buildReport, type MemorySummary } from "./memory-worker";
import { imageWorker, assetImage, mergeImageResults } from "./vision-worker";
import { serviceConfig } from "./services";

export type JobRow = typeof aiJobs.$inferSelect;
export const MAX_ATTEMPTS = 3;
const MAX_CONCURRENT = 2;
const LEASE_MS = 90_000;
const globalJobs = globalThis as typeof globalThis & { daiJobControllers?: Map<string, AbortController> };
const controllers = globalJobs.daiJobControllers ??= new Map();

export function jobView(job: JobRow): JobView {
  return { id: job.id, kind: job.kind, state: job.state, route: job.route, title: job.title,
    progress: job.progress, steps: job.steps, attempts: job.attempts, errorCode: job.errorCode,
    error: job.error, result: job.result, requester: job.requester, requesterDevice: job.requesterDevice,
    createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null };
}

/** Short transaction. Per-user lock makes idempotency + queue quotas atomic, including extraction draft creation. */
export async function enqueueJob(kind: JobKind, input: JobInput, session: SessionPayload, key: string, draft?: { title: string; tags: string[]; source: string; productName?: string | null; sku?: string | null; priceVnd?: number | null; quantity?: number | null }) {
  const { asOf: _asOf, extractionId: _extractionId, ...identity } = input;
  void _asOf; void _extractionId;
  const inputHash = createHash("sha256").update(JSON.stringify({ kind, ...identity, draft })).digest("hex");
  const tenantId = await tenantIdOf(session);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(34215, ${session.sub})`);
    // Object-level check is re-verified at admission: an extract/index job may only read in-scope media.
    if (kind === "extract" || kind === "asset.index") {
      const [asset] = await tx.select({ id: assets.id }).from(assets).where(and(eq(assets.id, input.assetId ?? -1), assetReadScope(session, tenantId))).limit(1);
      if (!asset) throw new AiError("ASSET_NOT_FOUND", "Không tìm thấy ảnh gốc trong phạm vi được phép.", 404);
    }
    if (kind === "report") {
      const [previous] = await tx.select({ text: messages.text }).from(messages).where(and(eq(messages.userId, session.sub), eq(messages.requestKey, key), eq(messages.role, "user"))).limit(1);
      if (previous && previous.text !== input.question) throw new AiError("IDEMPOTENCY_CONFLICT", "Mã yêu cầu đã được dùng cho câu hỏi khác.", 409);
    }
    const [existing] = await tx.select().from(aiJobs).where(and(eq(aiJobs.userId, session.sub), eq(aiJobs.idempotencyKey, key))).limit(1);
    if (existing) {
      if (existing.inputHash !== inputHash) throw new AiError("IDEMPOTENCY_CONFLICT", "Khóa yêu cầu đã được dùng với nội dung khác.", 409);
      return { job: existing, duplicate: true };
    }
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(aiJobs).where(and(eq(aiJobs.userId, session.sub), sql`${aiJobs.state} in ('queued','running')`));
    if (count >= 8) throw new AiError("QUEUE_FULL", "Bạn đang có 8 tác vụ chờ/chạy. Hãy chờ hoàn tất hoặc hủy bớt.", 429);
    const savedInput = { ...input, tenantId };
    if (kind === "extract" && draft) {
      const [ex] = await tx.insert(extractions).values({ tenantId, assetId: input.assetId!, title: draft.title, tags: draft.tags,
        note: input.note!, roi: input.roi, taskType: input.taskType, productName: draft.productName, sku: draft.sku, priceVnd: draft.priceVnd, quantity: draft.quantity, status: "PROCESSING", source: draft.source,
        createdBy: session.name, userId: session.sub }).returning();
      savedInput.extractionId = ex.id;
    }
    const [job] = await tx.insert(aiJobs).values({
      id: randomUUID(), tenantId, userId: session.sub, sessionId: session.sid, requester: session.name,
      requesterDevice: session.device, kind, title: draft?.title ?? input.question ?? (kind === "asset.index" ? "Chỉ mục ảnh" : "Tác vụ AI"),
      input: savedInput, inputHash, idempotencyKey: key,
      route: kind === "asset.index" || (kind === "extract" && requiredTools(kind, input.note, input.taskType).length === 1) ? "worker" : "hermes",
      steps: [{ id: "gateway", worker: "Dịch vụ AI", label: "Xác thực, kiểm tra quyền và lưu yêu cầu", state: "succeeded" }],
    }).returning();
    if (kind === "report") {
      await tx.insert(messages).values({ tenantId, userId: session.sub, role: "user", text: input.question!, device: session.device,
        inputMode: input.inputMode ?? "text", requestKey: key }).onConflictDoNothing();
    }
    await tx.insert(auditLog).values({ tenantId, actor: session.name, actorRole: session.role, device: session.device,
      action: "ai.job.queued", targetType: "job", targetId: job.id, detail: kind });
    return { job, duplicate: false };
  });
}

export async function getJob(id: string, session: SessionPayload) {
  const scoped = await authorizeResource(session, "job", id);
  return scoped.ok ? scoped.row : null;
}

async function claim(id: string): Promise<JobRow | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(673241)`);
    const now = new Date();
    const [job] = await tx.select().from(aiJobs).where(eq(aiJobs.id, id)).for("update").limit(1);
    if (!job || TERMINAL.includes(job.state) || (job.state === "running" && job.leaseUntil && job.leaseUntil > now)) return null;
    if (job.attempts >= MAX_ATTEMPTS) {
      await tx.update(aiJobs).set({ state: "failed", errorCode: "MAX_ATTEMPTS", error: "Đã đạt giới hạn 3 lần chạy. Tạo yêu cầu mới sau khi kiểm tra dịch vụ.", finishedAt: now }).where(eq(aiJobs.id, id));
      if (job.input.extractionId) await tx.update(extractions).set({ status: "FAILED", updatedAt: now }).where(and(eq(extractions.id, job.input.extractionId), eq(extractions.status, "PROCESSING")));
      return null;
    }
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(aiJobs).where(and(eq(aiJobs.state, "running"), gt(aiJobs.leaseUntil, now)));
    if (count >= MAX_CONCURRENT) return null;
    const [row] = await tx.update(aiJobs).set({ state: "running", attempts: job.attempts + 1,
      leaseUntil: new Date(now.getTime() + LEASE_MS), runToken: randomUUID(), updatedAt: now,
      progress: 5, error: null, errorCode: null }).where(eq(aiJobs.id, id)).returning();
    return row;
  });
}

export async function runJob(id: string) {
  const job = await claim(id);
  if (!job) return;
  const controller = new AbortController();
  controllers.set(id, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(55_000)]);
  const started = Date.now();
  const steps: Step[] = [{ id: "gateway", worker: "Dịch vụ AI", label: "Đã kiểm tra quyền và khóa yêu cầu", state: "succeeded" }];
  let writeChain = Promise.resolve();
  let route = job.route;
  let fallbackReason: string | undefined;
  const running = and(eq(aiJobs.id, job.id), eq(aiJobs.state, "running"), eq(aiJobs.runToken, job.runToken!));

  const persist = (progress: number) => {
    writeChain = writeChain.then(async () => {
      signal.throwIfAborted();
      const updated = await db.update(aiJobs).set({ steps: structuredClone(steps), route, progress: sql`greatest(${aiJobs.progress}, ${progress})`, updatedAt: new Date() }).where(running).returning({ id: aiJobs.id });
      if (!updated.length) throw new AiError("CANCELLED", "Tác vụ đã hủy hoặc được phiên chạy khác tiếp quản.", 409);
    });
    return writeChain;
  };

  try {
    // Recheck the originating session before delegating any work.
    const [allowed] = await db.select({ role: users.role }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, job.sessionId), eq(users.id, job.userId), eq(users.disabled, false), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()))).limit(1);
    if (!allowed || (job.kind === "extract" && allowed.role === "viewer")) throw new AiError("SESSION_REVOKED", "Phiên tạo tác vụ đã hết hạn, bị thu hồi hoặc không còn quyền.", 401);
    // Workers always query under the requester's scope — output can never outlive their permissions.
    const requester: SessionPayload = { sid: job.sessionId, sub: job.userId, name: job.requester, role: allowed.role as SessionPayload["role"], device: job.requesterDevice, exp: 0 };

    if (job.kind === "asset.index") {
      await indexAsset(job, requester, { signal, steps, running, started, persist });
      return;
    }

    let tools = requiredTools(job.kind, job.input.note, job.input.taskType);
    const useHermes = job.kind === "report" || tools.length > 1;
    const planning: Step = { id: "plan", worker: "Trợ lý AI", label: "Lập kế hoạch và chọn bước xử lý", state: useHermes ? "running" : "skipped", note: useHermes ? undefined : "Tác vụ đơn: chuyển thẳng đến xử lý AI, bỏ qua Trợ lý AI.", startedAt: new Date().toISOString() };
    steps.push(planning);
    await persist(12);
    if (useHermes) {
      const t = Date.now();
      try {
        const plan = await hermesPlan(job.kind, job.input, job.id, signal);
        tools = [...new Set([...plan.tools, ...tools])]; // never silently omit essential requested work
        route = "hermes";
        planning.state = "succeeded";
        planning.note = `Kế hoạch đã kiểm tra: ${tools.join(" → ")}`;
      } catch (e) {
        if (signal.aborted) throw e;
        const info = errorInfo(e);
        route = "fallback";
        planning.state = "failed";
        planning.note = `${info.code}: ${info.message}`;
        fallbackReason = `Trợ lý AI chưa sẵn sàng (${info.code}); hệ thống dùng kế hoạch dự phòng giới hạn. Không thay thế phân tích sâu bằng kết luận suy đoán.`;
      }
      planning.durationMs = Date.now() - t;
    } else route = "worker";

    const labels: Record<ToolName, string> = {
      "memory.summary": "Tổng hợp số liệu bằng SQL có kiểm soát",
      "memory.events": "Truy xuất bằng chứng từ sự kiện đã lưu",
      "vision.extract": "Quan sát và đếm trong ảnh/ROI",
      "ocr.extract": "Đọc văn bản, nhãn và bảng dữ liệu",
    };
    tools.forEach((tool) => steps.push({ id: tool, worker: tool.startsWith("memory") ? "Trí nhớ / SQL" : tool.startsWith("vision") ? "Nhận diện hình ảnh" : "Nhận dạng văn bản", label: labels[tool], state: "waiting" }));
    await persist(25);

    let summary: MemorySummary | undefined;
    let evidence: Awaited<ReturnType<typeof evidenceWorker>> = [];
    let vision: ExtractionResult | undefined, ocr: ExtractionResult | undefined;
    const failures: string[] = [];
    const image = job.kind === "extract" ? await assetImage(job.input.assetId!, job.input.roi, requester) : undefined;
    // At most two specialist calls in parallel, independent of the fast path.
    for (let i = 0; i < tools.length; i += 2) {
      await Promise.all(tools.slice(i, i + 2).map(async (tool) => {
        const step = steps.find((s) => s.id === tool)!;
        step.state = "running"; step.startedAt = new Date().toISOString();
        await persist(30);
        const t = Date.now();
        try {
          signal.throwIfAborted();
          if (tool === "memory.summary") summary = await summaryWorker(job.input);
          else if (tool === "memory.events") evidence = await evidenceWorker(job.input, requester);
          else if (tool === "vision.extract") vision = await imageWorker("vision", job.input, job.id, signal, image, requester);
          else if (tool === "ocr.extract") ocr = await imageWorker("ocr", job.input, job.id, signal, image, requester);
          step.state = "succeeded";
        } catch (e) {
          if (signal.aborted) throw e;
          const info = errorInfo(e);
          step.state = "failed"; step.note = `${info.code}: ${info.message}`;
          failures.push(`${step.worker}: ${info.message}`);
        }
        step.durationMs = Date.now() - t;
        await persist(75);
      }));
    }
    await writeChain;
    signal.throwIfAborted();
    const result: JobResult = {};
    let extractionResult: ExtractionResult | undefined;
    if (job.kind === "report") {
      if (!summary) throw new AiError("MEMORY_UNAVAILABLE", "Không truy xuất được số liệu nguồn. Không tạo báo cáo không có căn cứ.");
      result.answer = buildReport(summary, evidence, fallbackReason, requester.role);
      result.answer.warnings.push(...failures);
      result.answer.basedOnDemo = job.input.demoMode || answerBasedOnDemo(result.answer);
      result.answer.execution = { path: route, jobId: job.id, durationMs: Date.now() - started, reason: route === "hermes" ? "Trợ lý AI chọn công cụ; số liệu và bằng chứng do Trí nhớ/SQL cung cấp." : "Dịch vụ AI dự phòng: chỉ tổng hợp dữ liệu đã lưu, không phân tích video." };
    } else {
      extractionResult = mergeImageResults(vision, ocr);
      extractionResult.warnings.push(...failures);
      if (fallbackReason) extractionResult.warnings.push(fallbackReason);
      if (image?.demo) extractionResult.warnings.push("Ảnh đầu vào là ảnh mẫu do AI tạo, không phải camera thực.");
      extractionResult.structured.push({ key: "Nguồn bằng chứng", value: `asset:${job.input.assetId} · SHA-256: ${image!.sha256}`, confidence: 1 });
      result.extractionId = job.input.extractionId;
    }
    const partial = route === "fallback" || failures.length > 0;
    const finalState = partial ? "partial" : "succeeded";
    steps.push({ id: "complete", worker: "Dịch vụ AI", label: job.kind === "report" ? "Lưu báo cáo và liên kết bằng chứng" : "Lưu bản AI gốc, chờ người dùng xác minh", state: "succeeded" });
    await db.transaction(async (tx) => {
      // Row lock serializes cancellation with result commit, even on different server instances.
      const [current] = await tx.select().from(aiJobs).where(running).for("update").limit(1);
      if (!current) return;
      if (extractionResult && job.input.extractionId) {
        await tx.update(extractions).set({ rawResult: extractionResult, result: extractionResult, status: "REVIEW_REQUIRED", updatedAt: new Date() })
          .where(and(eq(extractions.id, job.input.extractionId), eq(extractions.status, "PROCESSING")));
      }
      if (result.answer) {
        const [assistant] = await tx.insert(messages).values({ tenantId: job.tenantId, userId: job.userId, role: "assistant", text: result.answer.short, answer: result.answer, requestKey: job.idempotencyKey,
          device: job.requesterDevice, inputMode: job.input.inputMode ?? "text" })
          .onConflictDoUpdate({ target: [messages.userId, messages.requestKey, messages.role], set: { text: result.answer.short, answer: result.answer } }).returning();
        result.assistantId = assistant.id;
      }
      await tx.update(aiJobs).set({ state: finalState, result, steps, progress: 100, route, finishedAt: new Date(), updatedAt: new Date(), leaseUntil: null,
        errorCode: partial ? "PARTIAL_RESULT" : null, error: partial ? fallbackReason ?? failures.join(" ") : null }).where(running);
      await tx.insert(auditLog).values({ tenantId: job.tenantId, actor: job.requester, device: job.requesterDevice, action: `ai.job.${finalState}`, targetType: "job", targetId: job.id, detail: `${route}; ${Date.now() - started}ms` });
    });
  } catch (e) {
    await writeChain.catch(() => {});
    const info = errorInfo(e);
    const [failed] = await db.update(aiJobs).set({ state: "failed", steps, route, errorCode: info.code, error: info.message,
      leaseUntil: null, finishedAt: new Date(), updatedAt: new Date() }).where(running).returning();
    if (failed && job.input.extractionId) await db.update(extractions).set({ status: "FAILED", updatedAt: new Date() }).where(and(eq(extractions.id, job.input.extractionId), eq(extractions.status, "PROCESSING")));
  } finally {
    controllers.delete(id);
  }
}

/** Lỗi không nên thử lại: cấu hình/consent/quyền/ảnh nguồn sẽ không tự khắc phục sau backoff. */
const INDEX_TERMINAL_CODES = new Set([
  "CONSENT_REQUIRED", "NOT_CONFIGURED", "INVALID_CONFIG", "MISSING_API_KEY", "MISSING_MODEL", "TLS_REQUIRED", "HERMES_DISABLED",
  "ASSET_NOT_FOUND", "ASSET_UNAVAILABLE", "IMAGE_TOO_LARGE", "INVALID_IMAGE", "NO_WORKER_RESULT",
  "SESSION_REVOKED", "CANCELLED", "IDEMPOTENCY_CONFLICT", "UNKNOWN_TASK", "QUEUE_FULL", "RATE_LIMITED", "MAX_ATTEMPTS",
]);

const INDEX_NOTE = "Lập chỉ mục ảnh: mô tả ngắn nội dung và đọc mọi văn bản, nhãn hoặc mã nhìn thấy trong ảnh.";

type IndexCtx = { signal: AbortSignal; steps: Step[]; running: SQL | undefined; started: number; persist: (progress: number) => Promise<void> };

/**
 * asset.index: một worker duy nhất (OCR nếu đã cấu hình, ngược lại mô tả ảnh) đọc nội dung
 * ảnh rồi ghi vào extractions taskType="index" — không planner, không model lớn. Lỗi tạm
 * được backoff bằng lease (job vẫn "running", dispatcher chỉ nhận lại khi lease hết,
 * attempts tăng dần tới MAX_ATTEMPTS); lỗi vĩnh viễn fail ngay với đúng error_code.
 */
async function indexAsset(job: JobRow, requester: SessionPayload, ctx: IndexCtx) {
  const step: Step = { id: "index", worker: "Nhận diện hình ảnh", label: "Đọc nội dung ảnh để phục vụ tìm kiếm", state: "running", startedAt: new Date().toISOString() };
  ctx.steps.push(step);
  await ctx.persist(40);
  const t = Date.now();
  try {
    ctx.signal.throwIfAborted();
    const service = serviceConfig("ocr") ? "ocr" : serviceConfig("vision") ? "vision" : null;
    if (!service) throw new AiError("NOT_CONFIGURED", "Chưa cấu hình dịch vụ xử lý ảnh để lập chỉ mục.", 503);
    const image = await assetImage(job.input.assetId!, null, requester);
    const extraction = await imageWorker(service, { ...job.input, note: INDEX_NOTE, taskType: service === "ocr" ? "ocr" : "describe" }, job.id, ctx.signal, image, requester);
    if (image.demo) extraction.warnings.push("Ảnh đầu vào là ảnh mẫu do AI tạo, không phải camera thực.");
    step.state = "succeeded";
    step.durationMs = Date.now() - t;
    ctx.steps.push({ id: "complete", worker: "Dịch vụ AI", label: "Lưu kết quả chỉ mục ảnh", state: "succeeded" });
    await db.transaction(async (tx) => {
      // Row lock serializes cancellation with result commit, even on different server instances.
      const [current] = await tx.select().from(aiJobs).where(ctx.running).for("update").limit(1);
      if (!current) return;
      const [asset] = await tx.select({ tenantId: assets.tenantId }).from(assets).where(eq(assets.id, job.input.assetId!)).limit(1);
      const [ex] = await tx.insert(extractions).values({ tenantId: asset?.tenantId ?? job.tenantId, assetId: job.input.assetId!,
        title: "Chỉ mục ảnh", note: "", taskType: "index", status: "REVIEW_REQUIRED",
        rawResult: extraction, result: extraction, source: image.demo ? "demo" : "live",
        createdBy: job.requester, userId: job.userId }).returning({ id: extractions.id });
      await tx.update(aiJobs).set({ state: "succeeded", result: { extractionId: ex.id }, steps: ctx.steps, progress: 100, route: "worker", finishedAt: new Date(), updatedAt: new Date(), leaseUntil: null }).where(ctx.running);
      await tx.insert(auditLog).values({ tenantId: job.tenantId, actor: job.requester, device: job.requesterDevice, action: "ai.job.succeeded", targetType: "job", targetId: job.id, detail: `index; ${Date.now() - ctx.started}ms` });
    });
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    step.state = "failed";
    step.durationMs = Date.now() - t;
    const info = errorInfo(e);
    step.note = `${info.code}: ${info.message}`;
    if (!INDEX_TERMINAL_CODES.has(info.code) && job.attempts < MAX_ATTEMPTS) {
      await db.update(aiJobs).set({ errorCode: info.code, error: info.message, steps: ctx.steps,
        leaseUntil: new Date(Date.now() + 2_000 * 2 ** (job.attempts - 1)), updatedAt: new Date() }).where(ctx.running);
    } else {
      await db.update(aiJobs).set({ state: "failed", steps: ctx.steps, route: "worker", errorCode: info.code, error: info.message, leaseUntil: null, finishedAt: new Date(), updatedAt: new Date() }).where(ctx.running);
      await db.insert(auditLog).values({ tenantId: job.tenantId, actor: job.requester, device: job.requesterDevice, action: "ai.job.failed", targetType: "job", targetId: job.id, detail: `index; ${info.code}` });
    }
  }
}

export async function changeJob(job: JobRow, action: "cancel" | "retry", actor: SessionPayload) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(aiJobs).where(eq(aiJobs.id, job.id)).for("update").limit(1);
    if (!current) throw new AiError("NOT_FOUND", "Không tìm thấy tác vụ.", 404);
    if (action === "cancel") {
      if (!["queued", "running"].includes(current.state)) throw new AiError("ALREADY_FINISHED", "Tác vụ đã kết thúc; không thể hủy.", 409);
      await tx.update(aiJobs).set({ state: "cancelled", errorCode: "CANCELLED", error: "Người dùng đã hủy tác vụ.", leaseUntil: null, finishedAt: new Date(), updatedAt: new Date() }).where(eq(aiJobs.id, job.id));
      if (current.input.extractionId) await tx.update(extractions).set({ status: "FAILED", updatedAt: new Date() }).where(and(eq(extractions.id, current.input.extractionId), eq(extractions.status, "PROCESSING")));
    } else {
      if (current.attempts >= MAX_ATTEMPTS) throw new AiError("MAX_ATTEMPTS", "Đã đạt giới hạn 3 lần chạy. Hãy kiểm tra dịch vụ trước khi tạo yêu cầu mới.", 409);
      if (!["failed", "partial", "cancelled"].includes(current.state)) throw new AiError("NOT_RETRYABLE", "Tác vụ chưa thể chạy lại.", 409);
      if (current.input.extractionId) {
        const [ex] = await tx.select().from(extractions).where(eq(extractions.id, current.input.extractionId)).for("update").limit(1);
        if (!ex) throw new AiError("SOURCE_DELETED", "Bản ghi trích xuất đã bị xóa.", 410);
        if (ex.status === "VERIFIED") throw new AiError("ALREADY_VERIFIED", "Kết quả đã xác minh; hãy tạo tác vụ mới để giữ nguyên bằng chứng cũ.", 409);
        await tx.update(extractions).set({ status: "PROCESSING", updatedAt: new Date() }).where(eq(extractions.id, ex.id));
      }
      await tx.update(aiJobs).set({ state: "queued", progress: 0, result: null, steps: [], error: null, errorCode: null, leaseUntil: null, runToken: null, finishedAt: null, updatedAt: new Date() }).where(eq(aiJobs.id, current.id));
    }
    await tx.insert(auditLog).values({ tenantId: job.tenantId, actor: actor.name, actorRole: actor.role, device: actor.device, action: `ai.job.${action}`, targetType: "job", targetId: current.id });
  });
  if (action === "cancel") controllers.get(job.id)?.abort();
}

/** Used by next.after() in preview and by the authenticated dispatcher in deployments. */
export async function dispatchJobs() {
  const rows = await db.select({ id: aiJobs.id }).from(aiJobs)
    .where(or(eq(aiJobs.state, "queued"), and(eq(aiJobs.state, "running"), lt(aiJobs.leaseUntil, new Date()))))
    .orderBy(asc(aiJobs.createdAt)).limit(MAX_CONCURRENT);
  await Promise.all(rows.map((r) => runJob(r.id)));
  return rows.length;
}

export async function listJobs(session: SessionPayload, all = false) {
  const tenantId = await tenantIdOf(session);
  return db.select().from(aiJobs)
    .where(and(eq(aiJobs.tenantId, tenantId), all && session.role === "owner" ? undefined : eq(aiJobs.userId, session.sub)))
    .orderBy(desc(aiJobs.createdAt)).limit(30);
}
