import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { ensureDefaultTenant } from "./helpers/tenant";
import { db, pool } from "../src/db";
import { aiJobs, assets, auditLog, cameras, events, extractions, messages, tenants, users } from "../src/db/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { assetReadScope, authorizeResource, extractionScope } from "../src/lib/scope";
import { tenantIdOf } from "../src/lib/knowledge/tenant";
import { enqueueJob, listJobs } from "../src/lib/ai/jobs";
import { AiError } from "../src/lib/ai/types";
import type { SessionPayload } from "../src/lib/token";

/**
 * H-01f — authorizeResource() phải khóa theo tenant của session.
 * Repro bug (artifacts/repro-h01f.ts): tenant 1 đọc/sửa/xoá được camera + event
 * của tenant 2 vì mọi truy vấn trong authorizeResource thiếu điều kiện tenant_id.
 * Suite này dựng tenant 2 + tài nguyên canary rồi assert qua authorizeResource
 * (lớp scope mà mọi route [id] đi qua) và các predicate export:
 *   - tenant 1 (owner/operator/viewer): camera/event/asset/extraction/job của
 *     tenant 2 → 404 đồng nhất, DB không đổi, kể cả owner (bypass user ≠ bypass tenant)
 *   - tenant 2 thấy tài nguyên của mình; user-scope trong cùng tenant giữ nguyên
 *   - insert path gắn tenant_id của session (enqueueJob), listJobs lọc tenant
 * Fixture dọn trong finally — test fail cũng không để lọt canary.
 */
const prefix = `h01f_${randomBytes(5).toString("hex")}`;

const sess = (user: { id: number; displayName: string }, role: SessionPayload["role"]): SessionPayload => ({
  sid: `${prefix}-sid-${user.id}`,
  sub: user.id,
  name: user.displayName,
  role,
  device: "test",
  exp: Math.floor(Date.now() / 1000) + 3600,
});

const denied404 = async (r: Promise<{ ok: boolean; response?: Response }>, what: string) => {
  const res = await r;
  assert.equal(res.ok, false, `${what} phải bị chặn`);
  assert.equal(res.response!.status, 404, `${what} phải trả 404 đồng nhất`);
};

after(async () => { await pool.end(); });

test("H-01f: authorizeResource chặn cross-tenant trên mọi kind", { timeout: 60000 }, async (t) => {
  let tenant2Id = 0;
  const userIds: number[] = [];
  const camIds: number[] = [];
  const evIds: number[] = [];
  const assetIds: number[] = [];
  const exIds: number[] = [];
  const jobIds: string[] = [];
  try {
    await ensureDefaultTenant();
    const [tenant2] = await db.insert(tenants).values({ slug: prefix, name: `${prefix} tenant` }).returning();
    tenant2Id = tenant2.id;
    const inserted = await db
      .insert(users)
      .values([
        { login: `${prefix}_t1_owner`, displayName: `${prefix}_t1_owner`, role: "owner", tenantId: 1 },
        { login: `${prefix}_t1_op`, displayName: `${prefix}_t1_op`, role: "operator", tenantId: 1 },
        { login: `${prefix}_t1_view`, displayName: `${prefix}_t1_view`, role: "viewer", tenantId: 1 },
        { login: `${prefix}_t2_owner`, displayName: `${prefix}_t2_owner`, role: "owner", tenantId: tenant2Id },
        { login: `${prefix}_t2_view`, displayName: `${prefix}_t2_view`, role: "viewer", tenantId: tenant2Id },
      ])
      .returning();
    userIds.push(...inserted.map((u) => u.id));
    const byLogin = (s: string) => inserted.find((u) => u.login === `${prefix}_${s}`)!;
    const t1Owner = byLogin("t1_owner"), t1Op = byLogin("t1_op"), t1View = byLogin("t1_view");
    const t2Owner = byLogin("t2_owner"), t2View = byLogin("t2_view");
    const s1Owner = sess(t1Owner, "owner"), s1Op = sess(t1Op, "operator"), s1View = sess(t1View, "viewer");
    const s2Owner = sess(t2Owner, "owner"), s2View = sess(t2View, "viewer");

    // --- Tenant 1 fixture: camera/event/asset/extraction của chính tenant 1 ---
    const [cam1] = await db.insert(cameras).values({ tenantId: 1, code: `${prefix}-c1`, name: `${prefix} T1 cam`, location: "L1", sourceType: "demo", status: "demo" }).returning();
    const [ev1] = await db.insert(events).values({ tenantId: 1, cameraId: cam1.id, type: "manual", label: `${prefix} t1 event`, source: "manual", clientReported: false }).returning();
    camIds.push(cam1.id); evIds.push(ev1.id);
    const sha1 = createHash("sha256").update(prefix).digest("hex");
    const [asset1] = await db.insert(assets).values({ tenantId: 1, kind: "image", mime: "image/jpeg", sha256: sha1, data: "AA==", origin: "upload", uploadedBy: `${prefix}_t1_owner`, userId: t1Owner.id }).returning();
    const [ex1] = await db.insert(extractions).values({ tenantId: 1, assetId: asset1.id, title: `${prefix} t1 note`, note: `${prefix} t1 secret`, status: "DRAFT", source: "live", createdBy: `${prefix}_t1_owner`, userId: t1Owner.id }).returning();
    assetIds.push(asset1.id); exIds.push(ex1.id);

    // --- Tenant 2 canary: mọi kind mà authorizeResource bọc ---
    const [cam2] = await db.insert(cameras).values({ tenantId: tenant2Id, code: `${prefix}-c2`, name: `${prefix} SCOPE-CANARY-CAM`, location: "SCOPE-CANARY-LOC", sourceType: "rtsp", sourceCiphertext: "x", streamName: `${prefix}_canary`, enabled: false, status: "offline" }).returning();
    const [ev2] = await db.insert(events).values({ tenantId: tenant2Id, cameraId: cam2.id, type: "person_in", objectClass: "person", label: `${prefix} CANARY-EVENT`, source: "live", clientReported: false, happenedAt: new Date() }).returning();
    camIds.push(cam2.id); evIds.push(ev2.id);
    const sha2 = `${sha1}-t2`;
    const [asset2] = await db.insert(assets).values({ tenantId: tenant2Id, kind: "image", mime: "image/jpeg", sha256: sha2, data: "AA==", origin: "upload", uploadedBy: `${prefix}_t2_owner`, userId: t2Owner.id }).returning();
    const [asset2cam] = await db.insert(assets).values({ tenantId: tenant2Id, kind: "image", mime: "image/jpeg", sha256: `${sha2}-cam`, data: "AA==", origin: "capture", uploadedBy: `${prefix}_t2_owner`, userId: t2Owner.id, cameraId: cam2.id }).returning();
    const [ex2] = await db.insert(extractions).values({ tenantId: tenant2Id, assetId: asset2.id, title: `${prefix} t2 note`, note: `${prefix} CANARY-NOTE`, status: "REVIEW_REQUIRED", source: "live", createdBy: `${prefix}_t2_owner`, userId: t2Owner.id }).returning();
    assetIds.push(asset2.id, asset2cam.id); exIds.push(ex2.id);
    const { job: job2 } = await enqueueJob("report", { question: `${prefix} report?`, demoMode: true, allowRemote: false, asOf: new Date().toISOString() }, s2Owner, `h01f:${randomUUID()}`);
    jobIds.push(job2.id);

    await t.test("job tạo bởi tenant 2 được gắn tenant_id của session", async () => {
      assert.equal(job2.tenantId, tenant2Id, "enqueueJob phải ghi tenant_id của session, không để default=1");
    });

    await t.test("tenant 1 không đọc được tài nguyên tenant 2 — mọi kind, mọi vai trò", async () => {
      for (const s of [s1Owner, s1Op, s1View]) {
        await denied404(authorizeResource(s, "camera", cam2.id), `camera read role=${s.role}`);
        await denied404(authorizeResource(s, "event", ev2.id), `event read role=${s.role}`);
        await denied404(authorizeResource(s, "asset", asset2.id), `asset read role=${s.role}`);
        await denied404(authorizeResource(s, "asset", asset2cam.id), `asset(camera-bound) read role=${s.role}`);
        await denied404(authorizeResource(s, "extraction", ex2.id), `extraction read role=${s.role}`);
        await denied404(authorizeResource(s, "job", job2.id), `job read role=${s.role}`);
      }
    });

    await t.test("owner tenant 1 không bypass tenant: write + job queue + predicate export", async () => {
      // Negative: job của tenant khác với role=owner → 404 (đường vòng owner bị chặn).
      await denied404(authorizeResource(s1Owner, "job", job2.id, "write"), "owner job write");
      await denied404(authorizeResource(s1Owner, "camera", cam2.id, "write"), "owner camera write");
      await denied404(authorizeResource(s1Owner, "event", ev2.id, "write"), "owner event write");
      await denied404(authorizeResource(s1Owner, "asset", asset2.id, "write"), "owner asset write");
      await denied404(authorizeResource(s1Owner, "extraction", ex2.id, "write"), "owner extraction write");
      // Predicate export cũng phải tự lọc tenant (list path) — không phụ thuộc caller truyền tenantId.
      const a = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.id, asset2cam.id), assetReadScope(s1Owner)));
      assert.equal(a.length, 0, "assetReadScope(owner) lọt camera-bound asset của tenant khác");
      const x = await db.select({ id: extractions.id }).from(extractions).where(and(eq(extractions.id, ex2.id), extractionScope(s1Owner, "write")));
      assert.equal(x.length, 0, "extractionScope(owner) lọt extraction của tenant khác");
    });

    await t.test("PATCH/DELETE giả lập qua lớp scope: 404 và DB không đổi", async () => {
      // Route PATCH/DELETE luôn authorizeResource(mode=write) trước khi đụng DB —
      // ở đây khóa lớp đó rồi đối soát toàn bộ cột trước/sau.
      const before = {
        cam: await db.select().from(cameras).where(eq(cameras.id, cam2.id)),
        ev: await db.select().from(events).where(eq(events.id, ev2.id)),
        asset: await db.select().from(assets).where(eq(assets.id, asset2.id)),
        ex: await db.select().from(extractions).where(eq(extractions.id, ex2.id)),
        job: await db.select().from(aiJobs).where(eq(aiJobs.id, job2.id)),
      };
      await denied404(authorizeResource(s1Op, "camera", cam2.id, "write"), "PATCH camera cross-tenant");
      await denied404(authorizeResource(s1Op, "event", ev2.id, "write"), "PATCH event cross-tenant");
      await denied404(authorizeResource(s1Owner, "asset", asset2.id, "write"), "DELETE asset cross-tenant");
      await denied404(authorizeResource(s1Owner, "extraction", ex2.id, "write"), "DELETE extraction cross-tenant");
      const afterRows = {
        cam: await db.select().from(cameras).where(eq(cameras.id, cam2.id)),
        ev: await db.select().from(events).where(eq(events.id, ev2.id)),
        asset: await db.select().from(assets).where(eq(assets.id, asset2.id)),
        ex: await db.select().from(extractions).where(eq(extractions.id, ex2.id)),
        job: await db.select().from(aiJobs).where(eq(aiJobs.id, job2.id)),
      };
      assert.deepEqual(afterRows, before, "hàng tenant 2 bị sửa/xoá dù scope đã từ chối");
    });

    await t.test("tenant 2 đọc tài nguyên của chính mình", async () => {
      assert.equal((await authorizeResource(s2Owner, "camera", cam2.id)).ok, true);
      assert.equal((await authorizeResource(s2Owner, "event", ev2.id)).ok, true);
      assert.equal((await authorizeResource(s2Owner, "asset", asset2.id)).ok, true);
      assert.equal((await authorizeResource(s2View, "asset", asset2cam.id)).ok, true, "viewer cùng tenant đọc camera-bound asset");
      assert.equal((await authorizeResource(s2Owner, "extraction", ex2.id)).ok, true);
      assert.equal((await authorizeResource(s2Owner, "job", job2.id)).ok, true);
    });

    await t.test("user-scope trong cùng tenant giữ nguyên (không nới quyền)", async () => {
      // viewer tenant 1 vẫn bị chặn object-bound của user khác trong cùng tenant.
      await denied404(authorizeResource(s1View, "asset", asset1.id), "viewer đọc asset user khác cùng tenant");
      await denied404(authorizeResource(s1View, "extraction", ex1.id), "viewer đọc extraction user khác cùng tenant");
      await denied404(authorizeResource(s1View, "extraction", ex1.id, "write"), "viewer sửa extraction user khác cùng tenant");
      await denied404(authorizeResource(s1View, "job", job2.id), "viewer đọc job user khác cùng tenant");
      // Shared (camera/event) cùng tenant vẫn mở như thiết kế.
      assert.equal((await authorizeResource(s1View, "camera", cam1.id)).ok, true);
      assert.equal((await authorizeResource(s1View, "event", ev1.id)).ok, true);
      assert.equal((await authorizeResource(s1Owner, "asset", asset1.id, "write")).ok, true, "owner cùng tenant vẫn sửa được");
    });

    await t.test("ID không tồn tại → 404 đồng nhất (không 500, không phân biệt tenant)", async () => {
      await denied404(authorizeResource(s1Owner, "camera", 99999991), "camera id ảo");
      await denied404(authorizeResource(s1Owner, "event", 99999991), "event id ảo");
      await denied404(authorizeResource(s1Owner, "asset", 99999991), "asset id ảo");
      await denied404(authorizeResource(s1Owner, "extraction", 99999991), "extraction id ảo");
      await denied404(authorizeResource(s1Owner, "job", randomUUID()), "job id ảo");
    });

    await t.test("hai request đồng thời cùng 1 ID không race gây lộ", async () => {
      const [r1, r2] = await Promise.all([
        authorizeResource(s1Owner, "camera", cam2.id, "read"),
        authorizeResource(s1Op, "camera", cam2.id, "write"),
      ]);
      assert.equal(r1.ok, false);
      assert.equal(r2.ok, false);
    });

    await t.test("enqueueJob extract trên asset tenant khác → ASSET_NOT_FOUND", async () => {
      await assert.rejects(
        enqueueJob("extract", { assetId: asset2.id, note: "probe", demoMode: false, allowRemote: false, asOf: new Date().toISOString() }, s1Owner, `h01f:${randomUUID()}`),
        (e) => e instanceof AiError && e.code === "ASSET_NOT_FOUND"
      );
    });

    await t.test("listJobs lọc tenant: owner all=queue chỉ trong tenant của mình", async () => {
      const all1 = await listJobs(s1Owner, true);
      assert.ok(!all1.some((j) => j.id === job2.id), "owner tenant 1 thấy job tenant 2 trong scope=all");
      const all2 = await listJobs(s2Owner, true);
      assert.ok(all2.some((j) => j.id === job2.id), "owner tenant 2 phải thấy job của tenant mình");
      const mine2 = await listJobs(s2View, true);
      assert.ok(!mine2.some((j) => j.id === job2.id), "non-owner vẫn chỉ thấy job của chính mình");
    });

    await t.test("không hồi quy: query events theo tenant của session (đường GET /api/events)", async () => {
      // Route GET giờ lọc events.tenantId = tenantIdOf(session) — kiểm chứng cùng điều kiện.
      const t1 = await tenantIdOf(s1Owner);
      const t2 = await tenantIdOf(s2Owner);
      assert.equal(t1, 1);
      assert.equal(t2, tenant2Id);
      const rows1 = await db.select({ id: events.id }).from(events).where(and(eq(events.tenantId, t1), like(events.label, `${prefix}%`)));
      assert.deepEqual(rows1.map((r) => r.id).sort(), [ev1.id]);
      const rows2 = await db.select({ id: events.id }).from(events).where(and(eq(events.tenantId, t2), like(events.label, `${prefix}%`)));
      assert.deepEqual(rows2.map((r) => r.id).sort(), [ev2.id]);
    });
  } finally {
    if (jobIds.length) await db.delete(aiJobs).where(inArray(aiJobs.id, jobIds));
    if (userIds.length) await db.delete(messages).where(inArray(messages.userId, userIds));
    if (exIds.length) await db.delete(extractions).where(inArray(extractions.id, exIds));
    if (camIds.length) await db.delete(events).where(inArray(events.cameraId, camIds));
    if (assetIds.length) await db.delete(assets).where(inArray(assets.id, assetIds));
    if (camIds.length) await db.delete(cameras).where(inArray(cameras.id, camIds));
    const auditIds = [...camIds, ...evIds, ...assetIds, ...exIds, ...jobIds].map(String);
    if (auditIds.length) await db.delete(auditLog).where(inArray(auditLog.targetId, auditIds));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    if (tenant2Id) await db.delete(tenants).where(eq(tenants.id, tenant2Id));
  }
});
