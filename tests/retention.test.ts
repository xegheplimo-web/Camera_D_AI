import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, sql, TransactionRollbackError } from "drizzle-orm";
import { db, pool } from "../src/db";
import { count, DAY_MS, FRESH, inTx, OLD, type Tx } from "./helpers/db";
import { appSettings, assets, auditLog, cameras, events, extractions } from "../src/db/schema";
import { purgeDemoData, retentionCutoff, runRetention, unlinkPending } from "../src/lib/retention";

/**
 * REAL-003 — retention + purge demo.
 * Unit: tính cutoff + guard retentionDays<=0 (không cần DB).
 * Integration: mọi thao tác huỷ diệt chạy TRONG transaction rồi rollback —
 * DB dev không mất dữ liệu, nhưng DELETE/UPDATE vẫn đi qua engine thật.
 * File kiểm thử local: nằm trong thư mục tạm riêng (DAI_DATA_DIR), không đụng data/.
 */

const testDataDir = mkdtempSync(join(tmpdir(), "dai-retention-test-"));
process.env.DAI_DATA_DIR = testDataDir;

const SHA = "b".repeat(64);



after(async () => {
  rmSync(testDataDir, { recursive: true, force: true });
  await pool.end();
}, { timeout: 20000 });

/* ---------------- unit ---------------- */

test("unit: retentionCutoff = now - N ngày", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  assert.equal(retentionCutoff(now, 1).toISOString(), "2026-11-02T12:00:00.000Z");
  assert.equal(retentionCutoff(now, 30).toISOString(), "2026-10-04T12:00:00.000Z");
  assert.equal(retentionCutoff(now, 0).toISOString(), now.toISOString());
});

test("guard: retentionDays<=0 → runRetention không xoá gì", async () => {
  await inTx(async (tx) => {
    await tx.insert(appSettings).values({ key: "retentionDays", value: 0 })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: 0, updatedAt: new Date() } });
    const evBefore = await count(tx, events);
    const r = await runRetention(tx);
    assert.deepEqual({ events: r.events, extractions: r.extractions, assets: r.assets, bytes: r.bytes }, { events: 0, extractions: 0, assets: 0, bytes: 0 });
    assert.equal(r.retentionDays, 0);
    assert.equal(await count(tx, events), evBefore);
    // Âm cũng phải no-op
    await tx.update(appSettings).set({ value: -5 }).where(eq(appSettings.key, "retentionDays"));
    const r2 = await runRetention(tx);
    assert.equal(r2.events, 0);
  });
});

/* ---------------- integration (trong transaction, rollback) ---------------- */

test("integration: retention xoá đúng hàng quá hạn, giữ asset còn tham chiếu", { timeout: 60000 }, async () => {
  await inTx(async (tx) => {
    await tx.insert(appSettings).values({ key: "retentionDays", value: 1 })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: 1, updatedAt: new Date() } });

    const [cam] = await tx.insert(cameras).values({ code: "CAM-RET-T", name: "T", location: "lab", sourceType: "demo", status: "demo" }).returning();
    const [camKeep] = await tx.insert(cameras).values({ code: "CAM-RET-K", name: "K", location: "lab", sourceType: "demo", status: "demo", retentionDays: 365 }).returning();

    // Assets: cũ còn được event mới tham chiếu → GIỮ; cũ chỉ được event hết hạn tham chiếu → XOÁ;
    // cũ mồ côi có file local → XOÁ + mất file; mới mồ côi → GIỮ (không đủ tuổi).
    const [aRef] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: "t-ref", origin: "detect", cameraId: cam.id, sizeBytes: 11, createdAt: OLD }).returning();
    const [aGone] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: "t-gone", origin: "detect", cameraId: cam.id, sizeBytes: 22, createdAt: OLD }).returning();
    const localFile = join(testDataDir, "detect", `${SHA}.jpg`);
    mkdirSync(join(testDataDir, "detect"), { recursive: true });
    writeFileSync(localFile, Buffer.from("jpeg-bytes"));
    const [aLocal] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: SHA, url: `local:detect/${SHA}.jpg`, origin: "detect", cameraId: cam.id, sizeBytes: 33, createdAt: OLD }).returning();
    const [aNewOrphan] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: "t-new", origin: "upload", cameraId: cam.id, sizeBytes: 44 }).returning();

    // Events
    const [evOld] = await tx.insert(events).values({ cameraId: cam.id, type: "motion", label: "old", assetId: aGone.id, source: "live", happenedAt: OLD }).returning();
    const [evNew] = await tx.insert(events).values({ cameraId: cam.id, type: "motion", label: "new", assetId: aRef.id, source: "live", happenedAt: FRESH }).returning();
    const [evCamKeep] = await tx.insert(events).values({ cameraId: camKeep.id, type: "motion", label: "keep-by-cam", source: "live", happenedAt: OLD }).returning();

    // Extractions: cũ → xoá; mới → giữ; mới nhưng trỏ event hết hạn → giữ nhưng event_id bị gỡ.
    const [exOld] = await tx.insert(extractions).values({ assetId: aGone.id, note: "old", source: "live", createdAt: OLD }).returning();
    const [exNew] = await tx.insert(extractions).values({ assetId: aRef.id, note: "new", source: "live", eventId: evNew.id }).returning();
    const [exDangling] = await tx.insert(extractions).values({ assetId: aRef.id, note: "link-old", source: "live", eventId: evOld.id }).returning();

    const expEvents = (await tx.select({ c: sql<number>`count(*)::int` }).from(events)
      .where(sql`${events.happenedAt} < now() - (coalesce((select c.retention_days from cameras c where c.id = ${events.cameraId} and c.retention_days > 0), 1)::int * interval '1 day')`))[0].c;
    const expExtractions = (await tx.select({ c: sql<number>`count(*)::int` }).from(extractions).where(sql`${extractions.createdAt} < now() - interval '1 day'`))[0].c;

    const r = await runRetention(tx);
    assert.equal(r.retentionDays, 1);
    assert.equal(r.events, expEvents, `events xoá phải khớp count quá cutoff (kể override camera)`);
    assert.equal(r.extractions, expExtractions);
    assert.ok(r.assets >= 2 && r.bytes >= 55, `assets=${r.assets} bytes=${r.bytes} (aGone 22 + aLocal 33)`);

    // Trạng thái sau chạy (vẫn trong tx)
    assert.equal((await tx.select({ id: events.id }).from(events).where(eq(events.id, evOld.id))).length, 0, "event cũ bị xoá");
    assert.equal((await tx.select({ id: events.id }).from(events).where(eq(events.id, evNew.id))).length, 1, "event mới giữ");
    assert.equal((await tx.select({ id: events.id }).from(events).where(eq(events.id, evCamKeep.id))).length, 1, "event camera override 365d giữ");
    assert.equal((await tx.select({ id: extractions.id }).from(extractions).where(eq(extractions.id, exOld.id))).length, 0, "extraction cũ bị xoá");
    assert.equal((await tx.select({ id: extractions.id }).from(extractions).where(eq(extractions.id, exNew.id))).length, 1);
    const [exD] = await tx.select({ eventId: extractions.eventId }).from(extractions).where(eq(extractions.id, exDangling.id));
    assert.equal(exD.eventId, null, "event_id chết phải được gỡ");
    assert.equal((await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, aRef.id))).length, 1, "asset còn tham chiếu giữ");
    assert.equal((await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, aGone.id))).length, 0, "asset hết tham chiếu + quá hạn bị xoá");
    assert.equal((await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, aLocal.id))).length, 0, "asset local quá hạn bị xoá");
    // Two-phase: trong transaction file CHƯA được xoá (nếu tx rollback thì không mất dữ liệu).
    assert.equal(existsSync(localFile), true, "file phải còn trên đĩa khi tx chưa commit");
    assert.ok(r.pendingFiles.includes(`local:detect/${SHA}.jpg`), "pendingFiles phải chứa file cần xoá sau commit");
    const un = await unlinkPending(r.pendingFiles);
    assert.ok(un.removed >= 1, "unlinkPending phải xoá file sau commit");
    assert.equal(existsSync(localFile), false, "sau unlinkPending file mới bị xoá");
    assert.equal((await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, aNewOrphan.id))).length, 1, "asset mới mồ côi giữ (age guard)");

    // Audit ghi đúng 1 dòng data.retention trong tx
    const [auditRow] = await tx.select({ detail: auditLog.detail }).from(auditLog).where(eq(auditLog.action, "data.retention")).orderBy(desc(auditLog.id)).limit(1);
    assert.match(auditRow?.detail ?? "", /events=\d+.*extractions=\d+.*assets=\d+/);
  });
});

test("integration: purge_demo chỉ xoá source='demo', giữ nguyên live", { timeout: 60000 }, async () => {
  await inTx(async (tx) => {
    const [cam] = await tx.insert(cameras).values({ code: "CAM-PURGE-T", name: "P", location: "lab", sourceType: "demo", status: "demo" }).returning();
    const [dAsset] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: "p-demo", url: "/cams/cam1.jpg", origin: "demo", cameraId: cam.id }).returning();
    const [lAsset] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: "p-live", origin: "upload", cameraId: cam.id }).returning();
    const [lEv] = await tx.insert(events).values({ cameraId: cam.id, type: "motion", label: "live-ev", assetId: dAsset.id, source: "live", happenedAt: FRESH }).returning();
    const [lEx] = await tx.insert(extractions).values({ assetId: dAsset.id, note: "live-ex", source: "live", eventId: lEv.id }).returning();
    // Fixture TỰ tạo dữ liệu demo — không phụ thuộc DB đang có sẵn demo rows (test phải hermetic).
    await tx.insert(events).values({ cameraId: cam.id, type: "motion", label: "demo-ev", assetId: dAsset.id, source: "demo", happenedAt: FRESH });
    await tx.insert(extractions).values({ assetId: dAsset.id, note: "demo-ex", source: "demo" });
    // asset demo mồ côi (không extraction nào tham chiếu) → phải bị xoá; url=null để không đụng file thật.
    const [dOrphan] = await tx.insert(assets).values({ kind: "image", mime: "image/jpeg", sha256: "p-demo-orphan", url: null, origin: "demo", cameraId: cam.id }).returning();

    const liveEvBefore = await count(tx, events, sql`${events.source} <> 'demo'`);
    const liveExBefore = await count(tx, extractions, sql`${extractions.source} <> 'demo'`);
    const liveAsetBefore = await count(tx, assets, sql`${assets.origin} <> 'demo'`);

    const r = await purgeDemoData(tx, { name: "tester", role: "owner", device: "test" });
    assert.ok(r.events > 0 && r.extractions >= 1 && r.assets >= 1, `report=${JSON.stringify(r)}`);

    assert.equal(await count(tx, events, eq(events.source, "demo")), 0, "demo events phải = 0");
    assert.equal(await count(tx, extractions, eq(extractions.source, "demo")), 0, "demo extractions phải = 0");
    // asset demo còn được live extraction tham chiếu (asset_id NOT NULL) → giữ lại, đếm trong assetsKept
    assert.equal(await count(tx, assets, eq(assets.origin, "demo")), r.assetsKept, "demo asset mồ côi phải = 0");
    assert.equal(r.assetsKept, 1, "dAsset được lEx tham chiếu → giữ");
    assert.equal((await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, dOrphan.id))).length, 0, "asset demo mồ côi bị xoá");
    assert.equal(await count(tx, events, sql`${events.source} <> 'demo'`), liveEvBefore, "live events giữ nguyên");
    assert.equal(await count(tx, extractions, sql`${extractions.source} <> 'demo'`), liveExBefore);
    assert.equal(await count(tx, assets, sql`${assets.origin} <> 'demo'`), liveAsetBefore);

    // Live event còn nguyên nhưng asset_id trỏ demo asset đã gỡ → NULL
    const [ev] = await tx.select({ assetId: events.assetId }).from(events).where(eq(events.id, lEv.id));
    assert.equal(ev.assetId, null, "asset_id trỏ demo asset đã xoá phải được dọn");
    const [ex] = await tx.select({ assetId: extractions.assetId }).from(extractions).where(eq(extractions.id, lEx.id));
    assert.equal(ex.assetId, dAsset.id, "extraction live giữ nguyên tham chiếu asset được giữ");
    assert.equal((await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, lAsset.id))).length, 1, "asset live giữ");

    const [auditRow] = await tx.select({ actor: auditLog.actor }).from(auditLog).where(eq(auditLog.action, "data.purge_demo")).orderBy(desc(auditLog.id)).limit(1);
    assert.equal(auditRow?.actor, "tester");
  });
});
