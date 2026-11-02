import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import { db, pool } from "../src/db";
import { appSettings, cameras, events } from "../src/db/schema";
import { demoAlreadySeeded, markDemoSeeded, DEMO_SEEDED_KEY } from "../src/lib/seed";

/**
 * T-1305b — marker "đã seed demo" và dấu hiệu topology demo.
 * Bug gốc: ensureSeed return sớm khi cameras có BẤT KỲ row nào → bật CAMDAI_DEMO_SEED
 * sau khi thêm camera thật không seed demo. Sửa: marker app_settings.demoSeeded
 * + dấu hiệu demo cụ thể (code CAM-01..04 của seed, event source='demo') —
 * KHÔNG nhầm camera mô phỏng do user tự thêm (code CAM-<uuid>, sourceType='demo').
 *
 * Mọi thao tác chạy TRONG transaction rồi rollback — app_db không đổi gì sau test,
 * kể cả khi DB đang có sẵn topology demo cũ.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function inTx(fn: (tx: Tx) => Promise<void>) {
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      tx.rollback();
    });
  } catch (e) {
    if (!(e instanceof TransactionRollbackError)) throw e;
  }
}

/** Xoá mọi dấu hiệu demo TRONG tx để test độc lập với trạng thái thật của DB dev. */
async function clearDemoSignals(tx: Tx) {
  await tx.delete(appSettings).where(eq(appSettings.key, DEMO_SEEDED_KEY));
  await tx.delete(events).where(eq(events.source, "demo"));
  await tx.delete(cameras).where(inArray(cameras.code, ["CAM-01", "CAM-02", "CAM-03", "CAM-04"]));
}

after(async () => {
  await pool.end();
}, { timeout: 20000 });

test("demoAlreadySeeded: marker / topology CAM-01..04 / event demo → true; camera thật & camera mô phỏng của user → false", async () => {
  await inTx(async (tx) => {
    await clearDemoSignals(tx);
    assert.equal(await demoAlreadySeeded(tx), false, "không dấu hiệu nào → chưa seed");

    // Camera mô phỏng user tự thêm qua /camera (code CAM-<uuid>, sourceType='demo') KHÔNG được chặn seed.
    const [sim] = await tx.insert(cameras).values({ code: "CAM-A1B2C3D4", name: "Sim user", location: "lab", sourceType: "demo", status: "demo" }).returning();
    assert.equal(await demoAlreadySeeded(tx), false, "camera mô phỏng của user không tính là đã seed");

    // Camera thật (rtsp/webcam) không chặn demo seed — đây là bug gốc của T-1305.
    await tx.insert(cameras).values({ code: "CAM-REAL", name: "Real", location: "lab", sourceType: "rtsp", status: "offline" });
    assert.equal(await demoAlreadySeeded(tx), false, "camera thật không chặn demo seed");

    // Topology do seed tạo: code cố định CAM-01..04 → đã seed (upgrade-safety cho DB cũ chưa có marker).
    await tx.insert(cameras).values({ code: "CAM-01", name: "Camera 01", location: "x", sourceType: "webcam", status: "demo" });
    assert.equal(await demoAlreadySeeded(tx), true, "camera code CAM-01 → đã seed");
    await tx.delete(cameras).where(eq(cameras.code, "CAM-01"));
    assert.equal(await demoAlreadySeeded(tx), false);

    // Event demo sót lại (topology đã bị xoá tay) → đã seed.
    await tx.insert(events).values({ cameraId: sim.id, type: "motion", label: "demo-leftover", source: "demo" });
    assert.equal(await demoAlreadySeeded(tx), true, "event source='demo' → đã seed");
    await tx.delete(events).where(eq(events.source, "demo"));
    assert.equal(await demoAlreadySeeded(tx), false);

    // Marker bền → đã seed; ghi 2 lần không nhân đôi.
    await markDemoSeeded(tx);
    assert.equal(await demoAlreadySeeded(tx), true, "marker demoSeeded → đã seed");
    await markDemoSeeded(tx);
    const [m] = await tx.select({ c: sql<number>`count(*)::int` }).from(appSettings).where(eq(appSettings.key, DEMO_SEEDED_KEY));
    assert.equal(m.c, 1, "markDemoSeeded idempotent (onConflictDoNothing)");
    const [row] = await tx.select({ v: appSettings.value }).from(appSettings).where(eq(appSettings.key, DEMO_SEEDED_KEY));
    assert.equal(row.v, "1", "marker value === \"1\"");
  });
});
