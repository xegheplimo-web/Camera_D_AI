import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { desc, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { db, pool } from "../src/db";
import { count, DAY_MS, FRESH, inTx, OLD, type Tx } from "./helpers/db";
import { appSettings, assets, auditLog, cameras, events, knowledgeImages, knowledgeItems, tenants } from "../src/db/schema";
import { purgeDemoData, runRetention, unlinkPending } from "../src/lib/retention";

/**
 * T-1338 — ảnh trí nhớ không theo chính sách xoá của ảnh sự kiện.
 * knowledge_images.asset_id là FK ON DELETE CASCADE: retention xoá asset sẽ
 * kéo mất luôn hàng tham chiếu → runRetention/purgeDemoData phải loại trừ
 * asset đang được knowledge_images giữ. Mọi thao tác huỷ diệt chạy TRONG
 * transaction rồi rollback — DB dev không mất dữ liệu (cùng harness retention.test.ts).
 * File local nằm trong thư mục tạm riêng (DAI_DATA_DIR), không đụng data/.
 */

const testDataDir = mkdtempSync(join(tmpdir(), "dai-t1338-test-"));
process.env.DAI_DATA_DIR = testDataDir;

const SHA_KEEP = "c".repeat(64);
const SHA_GONE = "d".repeat(64);



/** Số asset quá hạn (cutoff 1 ngày) chỉ còn knowledge_images giữ — cùng vị ngữ production. */
const keptByKnowledge = async (tx: Tx) =>
  (await tx.select({ c: sql<number>`count(*)::int` }).from(assets).where(sql`${assets.createdAt} < now() - interval '1 day'
    and ${assets.id} not in (select asset_id from events where asset_id is not null)
    and ${assets.id} not in (select asset_id from extractions where asset_id is not null)
    and ${assets.id} in (select asset_id from knowledge_images where asset_id is not null)`))[0].c;

/** Số asset demo được knowledge_images giữ mà không extraction nào giữ — cùng vị ngữ production. */
const demoKeptByKnowledge = async (tx: Tx) =>
  (await tx.select({ c: sql<number>`count(*)::int` }).from(assets).where(sql`${assets.origin} = 'demo'
    and ${assets.id} in (select asset_id from knowledge_images where asset_id is not null)
    and ${assets.id} not in (select asset_id from extractions where asset_id is not null)`))[0].c;

/** Tenant riêng cho fixture — tự dọn qua rollback, không phụ thuộc tenant 'default'. */
async function newTenant(tx: Tx, tag: string) {
  const [t] = await tx.insert(tenants).values({ slug: `t1338-${tag}-${randomBytes(4).toString("hex")}`, name: `t1338 ${tag}` }).returning();
  return t.id;
}

/** Tạo mục tri thức + dòng knowledge_images trỏ vào asset. */
async function linkKnowledge(tx: Tx, tenantId: number, assetId: number, title: string) {
  const [item] = await tx.insert(knowledgeItems).values({ tenantId, title }).returning();
  await tx.insert(knowledgeImages).values({ tenantId, itemId: item.id, assetId, note: "ảnh trí nhớ" });
}

after(async () => {
  rmSync(testDataDir, { recursive: true, force: true });
  await pool.end();
}, { timeout: 20000 });

/* ---------------- runRetention: guard knowledge_images ---------------- */

test("T-1338.1: asset quá hạn chỉ được knowledge_images tham chiếu ⇒ giữ hàng + giữ file", { timeout: 60000 }, async () => {
  await inTx(async (tx) => {
    await tx.insert(appSettings).values({ key: "retentionDays", value: 1 })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: 1, updatedAt: new Date() } });
    const [cam] = await tx.insert(cameras).values({ code: "CAM-T1338-1", name: "K1", location: "lab", sourceType: "demo", status: "demo" }).returning();
    const tenantId = await newTenant(tx, "r1");
    const base = await keptByKnowledge(tx);

    const localFile = join(testDataDir, "detect", `${SHA_KEEP}.jpg`);
    mkdirSync(join(testDataDir, "detect"), { recursive: true });
    writeFileSync(localFile, Buffer.from("knowledge-bytes"));
    const [a] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: SHA_KEEP, url: `local:detect/${SHA_KEEP}.jpg`, origin: "capture", cameraId: cam.id, sizeBytes: 15, createdAt: OLD }).returning();
    await linkKnowledge(tx, tenantId, a.id, "t1338 mục giữ");

    const r = await runRetention(tx);
    assert.equal(r.assetsKeptByKnowledge, base + 1, `assetsKeptByKnowledge=${r.assetsKeptByKnowledge} phải = baseline ${base} + 1`);
    assert.equal(await count(tx, assets, eq(assets.id, a.id)), 1, "hàng assets phải còn");
    assert.equal(await count(tx, knowledgeImages, eq(knowledgeImages.assetId, a.id)), 1, "hàng knowledge_images không bị cascade xoá");
    assert.equal(existsSync(localFile), true, "file trí nhớ phải còn trên đĩa trong tx");
    assert.ok(!r.pendingFiles.includes(`local:detect/${SHA_KEEP}.jpg`), "file trí nhớ không được vào pendingFiles");
    await unlinkPending(r.pendingFiles);
    assert.equal(existsSync(localFile), true, "sau unlinkPending file trí nhớ vẫn phải còn");

    const [auditRow] = await tx.select({ detail: auditLog.detail }).from(auditLog).where(eq(auditLog.action, "data.retention")).orderBy(desc(auditLog.id)).limit(1);
    assert.match(auditRow?.detail ?? "", new RegExp(`keptKnowledge=${base + 1}\\b`), "audit detail phải ghi keptKnowledge");
  });
});

test("T-1338.2: asset quá hạn không ai tham chiếu ⇒ vẫn bị xoá hàng + xoá file", { timeout: 60000 }, async () => {
  await inTx(async (tx) => {
    await tx.insert(appSettings).values({ key: "retentionDays", value: 1 })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: 1, updatedAt: new Date() } });
    const [cam] = await tx.insert(cameras).values({ code: "CAM-T1338-2", name: "K2", location: "lab", sourceType: "demo", status: "demo" }).returning();

    const localFile = join(testDataDir, "detect", `${SHA_GONE}.jpg`);
    mkdirSync(join(testDataDir, "detect"), { recursive: true });
    writeFileSync(localFile, Buffer.from("orphan-bytes"));
    const [a] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: SHA_GONE, url: `local:detect/${SHA_GONE}.jpg`, origin: "detect", cameraId: cam.id, sizeBytes: 21, createdAt: OLD }).returning();

    const r = await runRetention(tx);
    assert.equal(await count(tx, assets, eq(assets.id, a.id)), 0, "asset mồ côi quá hạn phải bị xoá");
    assert.ok(r.assets >= 1, "report.assets phải đếm ít nhất asset vừa xoá");
    assert.ok(r.pendingFiles.includes(`local:detect/${SHA_GONE}.jpg`), "file mồ côi phải vào pendingFiles");
    await unlinkPending(r.pendingFiles);
    assert.equal(existsSync(localFile), false, "file mồ côi phải bị xoá sau commit");
  });
});

test("T-1338.3: asset cũ được event mới tham chiếu ⇒ vẫn giữ (hành vi cũ)", { timeout: 60000 }, async () => {
  await inTx(async (tx) => {
    await tx.insert(appSettings).values({ key: "retentionDays", value: 1 })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: 1, updatedAt: new Date() } });
    const [cam] = await tx.insert(cameras).values({ code: "CAM-T1338-3", name: "K3", location: "lab", sourceType: "demo", status: "demo" }).returning();
    const base = await keptByKnowledge(tx);

    const [a] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: "t1338-evref", origin: "detect", cameraId: cam.id, sizeBytes: 8, createdAt: OLD }).returning();
    await tx.insert(events).values({ cameraId: cam.id, type: "motion", label: "fresh", assetId: a.id, source: "live", happenedAt: FRESH });

    const r = await runRetention(tx);
    assert.equal(await count(tx, assets, eq(assets.id, a.id)), 1, "asset còn event tham chiếu phải giữ");
    assert.equal(r.assetsKeptByKnowledge, base, "asset không thuộc knowledge không được tính vào assetsKeptByKnowledge");
  });
});

/* ---------------- purgeDemoData: guard knowledge_images ---------------- */

test("T-1338.4: purgeDemoData giữ asset demo đang được knowledge_images dùng", { timeout: 60000 }, async () => {
  await inTx(async (tx) => {
    const [cam] = await tx.insert(cameras).values({ code: "CAM-T1338-4", name: "K4", location: "lab", sourceType: "demo", status: "demo" }).returning();
    const tenantId = await newTenant(tx, "p4");
    const base = await demoKeptByKnowledge(tx);

    // Asset demo được danh mục tri thức dùng → GIỮ; asset demo mồ côi → XOÁ (url=null khỏi đụng file).
    const [dKeep] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: "t1338-dkeep", url: null, origin: "demo", cameraId: cam.id }).returning();
    await linkKnowledge(tx, tenantId, dKeep.id, "t1338 mục demo");
    const [dGone] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: "t1338-dgone", url: null, origin: "demo", cameraId: cam.id }).returning();

    const r = await purgeDemoData(tx, { name: "t1338", role: "owner", device: "test" });
    assert.equal(await count(tx, assets, eq(assets.id, dKeep.id)), 1, "asset demo được knowledge giữ phải còn");
    assert.equal(await count(tx, knowledgeImages, eq(knowledgeImages.assetId, dKeep.id)), 1, "hàng knowledge_images không bị cascade xoá");
    assert.equal(await count(tx, assets, eq(assets.id, dGone.id)), 0, "asset demo mồ côi phải bị xoá");
    assert.ok(r.assetsKeptByKnowledge >= base + 1, `assetsKeptByKnowledge=${r.assetsKeptByKnowledge} phải >= baseline ${base} + 1`);
    assert.equal(await count(tx, assets, eq(assets.origin, "demo")), r.assetsKept, "asset demo còn lại = assetsKept");

    const [auditRow] = await tx.select({ detail: auditLog.detail }).from(auditLog).where(eq(auditLog.action, "data.purge_demo")).orderBy(desc(auditLog.id)).limit(1);
    assert.match(auditRow?.detail ?? "", /keptKnowledge=\d+/, "audit purge phải ghi keptKnowledge");
  });
});
