/**
 * T-1346 — guard một-instance cho detector.
 *
 * Ca 1–3 là unit thuần (không DB). Ca 4–6 chạy trên Postgres thật vì bản chất
 * của guard là advisory lock của Postgres: fake sẽ không chứng minh được gì.
 * DB dùng DATABASE_URL của CI; test idempotent (tự dọn hàng đã tạo).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import { cameras, events } from "../src/db/schema";
import { DetectorLease, leaseKeyFor, LEASE_CLASS } from "../src/lib/camera/detector-lease";
import { recordDetection } from "../src/lib/camera/detector";
import { ensureDefaultTenant } from "./helpers/tenant";

process.env.DETECTOR_LEASE_RETRY_MS = "0"; // test không phải chờ 30 s
process.env.DETECT_MOTION_THRESHOLD ??= "0.008";
process.env.DETECT_COOLDOWN_SECONDS ??= "60";

test("unit: leaseKeyFor trả (classid, objid) và từ chối id ngoài phạm vi", () => {
  assert.deepEqual(leaseKeyFor(441), { classid: LEASE_CLASS, objid: 441 });
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
    assert.throws(() => leaseKeyFor(bad), /không hợp lệ/);
  }
});

test("unit: lease rỗng — owns=false, status sạch", () => {
  const lease = new DetectorLease();
  assert.equal(lease.owns(441), false);
  assert.deepEqual(lease.status, { connected: false, owned: [], standby: [], lastAttemptAt: null, lastError: null });
});

test("integration: hai lease cùng camera — chỉ một owner, lease kia standby", async () => {
  const a = new DetectorLease();
  const b = new DetectorLease();
  try {
    await a.ensure([441]);
    assert.equal(a.owns(441), true, "lease A phải giữ lock");
    assert.deepEqual(a.status.owned, [441]);

    await b.ensure([441]);
    assert.equal(b.owns(441), false, "lease B không được giữ lock thứ hai");
    assert.deepEqual(b.status.standby, [441]);
    assert.equal(b.status.connected, true, "B vẫn kết nối DB, chỉ không sở hữu");

    // A chết ⇒ B tiếp quản được (advisory lock nhả theo session).
    await a.close();
    await b.ensure([441]);
    assert.equal(b.owns(441), true, "B phải tiếp quản sau khi A đóng");
  } finally {
    await a.close();
    await b.close();
  }
});

test("integration: ensure([1,2]) rồi ensure([2]) nhả lock của camera đã gỡ", async () => {
  const a = new DetectorLease();
  const c = new DetectorLease();
  try {
    await a.ensure([441, 442]);
    assert.deepEqual(a.status.owned, [441, 442]);

    await a.ensure([442]);
    assert.deepEqual(a.status.owned, [442], "camera 441 phải được nhả");

    await c.ensure([441]);
    assert.equal(c.owns(441), true, "lease khác phải acquire được 441 sau khi nhả");
  } finally {
    await a.close();
    await c.close();
  }
});

test("integration: cooldown do DB quyết — frame khác nhau trong 60 s vẫn chỉ 1 event", async () => {
  await ensureDefaultTenant();
  const [cam] = await db
    .insert(cameras)
    .values({ code: `T1346C${Date.now() % 100000}`, name: "T1346 cooldown", location: "test", sourceType: "rtsp", streamName: "dai_cam_999999" })
    .returning({ id: cameras.id });
  const camRow = { id: cam.id, name: "T1346 cooldown", location: "test" };
  try {
    const first = await recordDetection(camRow, Buffer.from("frame-one-" + cam.id), 0.05);
    assert.equal(first.duplicate, false, "event đầu tiên phải được ghi");

    // Frame KHÁC (sha khác) nhưng trong cùng cooldown ⇒ chặn ở tầng DB.
    const second = await recordDetection(camRow, Buffer.from("frame-two-" + cam.id), 0.06);
    assert.equal(second.duplicate, true, "event thứ hai trong 60 s phải bị cooldown DB chặn");
    assert.equal(second.eventId, first.eventId, "phải trả về event đang giữ cooldown");

    const [{ c }] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(events)
      .where(and(eq(events.cameraId, cam.id), eq(events.createdBy, "detector")));
    assert.equal(c, 1, "chỉ được có đúng 1 event cho camera trong cooldown");
  } finally {
    await db.delete(events).where(eq(events.cameraId, cam.id));
    await db.delete(cameras).where(eq(cameras.id, cam.id));
  }
});
