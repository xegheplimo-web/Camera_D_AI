import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ensureDefaultTenant } from "./helpers/tenant";
import { db, pool } from "../src/db";
import { tenants, users, cameras, events } from "../src/db/schema";
import { eq, inArray } from "drizzle-orm";
import { answerQuestion } from "../src/lib/qa";
import type { SessionPayload } from "../src/lib/token";

/**
 * H-01b — qa.ts phải scope theo tenant của session.
 * Repro bug: detectCamera() đọc `db.select().from(cameras)` không lọc tenant →
 * chatbot tenant 1 trả lời bằng camera tenant 2. Suite này dựng tenant 2 + camera
 * canary (tên/địa chỉ duy nhất) rồi assert cả hai chiều qua answerQuestion:
 *   - session tenant 1: không bao giờ thấy marker của camera/sự kiện tenant 2
 *   - session tenant 2: thấy đúng camera của mình
 * Fixture dọn trong finally — test fail cũng không để lọt canary.
 */
const prefix = `h01b_${randomBytes(5).toString("hex")}`;
const CANARY = { name: `${prefix}CanaryCam`, location: `${prefix}CanaryLoc` };
const T1DUP = { name: `${prefix}T1Cam`, location: `${prefix}T1Loc` };
const T2DUP = { name: `${prefix}T2Cam`, location: `${prefix}T2Loc` };
const T2DOOR = { name: `${prefix}T2DoorCam`, location: `${prefix}T2DoorLoc` };
const EV_LABEL = `${prefix} CANARY-EVENT-X`;

const json = (a: unknown) => JSON.stringify(a);
const sess = (user: { id: number; displayName: string }): SessionPayload => ({
  sid: `${prefix}-sid-${user.id}`,
  sub: user.id,
  name: user.displayName,
  role: "owner", // owner ⇒ user-scope không che giấu lỗi: cách ly chỉ còn do tenant filter
  device: "test",
  exp: Math.floor(Date.now() / 1000) + 3600,
});

after(async () => { await pool.end(); });

test("H-01b: answerQuestion scopes cameras/events theo tenant của session", { timeout: 60000 }, async (t) => {
  let tenant2Id = 0;
  const userIds: number[] = [];
  const camIds: number[] = [];
  try {
    await ensureDefaultTenant();
    const [tenant2] = await db.insert(tenants).values({ slug: prefix, name: `${prefix} tenant` }).returning();
    tenant2Id = tenant2.id;
    const [user1, user2] = await db
      .insert(users)
      .values([
        { login: `${prefix}_t1`, displayName: `${prefix}_t1`, role: "owner", tenantId: 1 },
        { login: `${prefix}_t2`, displayName: `${prefix}_t2`, role: "owner", tenantId: tenant2Id },
      ])
      .returning();
    userIds.push(user1.id, user2.id);
    const s1 = sess(user1);
    const s2 = sess(user2);

    const inserted = await db
      .insert(cameras)
      .values([
        { tenantId: tenant2Id, code: "CAM-99", name: CANARY.name, location: CANARY.location, sourceType: "demo", status: "demo" },
        { tenantId: 1, code: "CAM-88", name: T1DUP.name, location: T1DUP.location, sourceType: "demo", status: "demo" },
        { tenantId: tenant2Id, code: "CAM-88", name: T2DUP.name, location: T2DUP.location, sourceType: "demo", status: "demo" },
        { tenantId: tenant2Id, code: "CAM-01", name: T2DOOR.name, location: T2DOOR.location, sourceType: "demo", status: "demo" },
      ])
      .returning();
    camIds.push(...inserted.map((c) => c.id));
    const canaryCam = inserted.find((c) => c.code === "CAM-99")!;

    await t.test("camera 99 không có trong tenant 1 → INSUFFICIENT_DATA, không fallback sang tenant 2", async () => {
      const a = await answerQuestion("Camera 99 hôm nay có bao nhiêu khách?", s1);
      assert.equal(a.kind, "INSUFFICIENT_DATA");
      assert.ok(!json(a).includes(CANARY.name), "lộ tên camera tenant 2");
      assert.ok(!json(a).includes(CANARY.location), "lộ địa chỉ camera tenant 2");
    });

    await t.test("sự kiện tenant 2 không lọt vào count/search của tenant 1", async () => {
      const q = "Hôm nay có bao nhiêu khách?";
      const baseline = await answerQuestion(q, s1);
      await db.insert(events).values(
        Array.from({ length: 3 }, () => ({
          tenantId: tenant2Id, cameraId: canaryCam.id, type: "person_in", objectClass: "person",
          label: EV_LABEL, source: "live", clientReported: false, happenedAt: new Date(),
        }))
      );
      const afterAns = await answerQuestion(q, s1);
      assert.equal(afterAns.kind, baseline.kind);
      assert.equal(afterAns.value, baseline.value, "count tenant 1 bị cộng thêm sự kiện tenant 2");
      const find = await answerQuestion(`tìm ${prefix}`, s1);
      assert.ok(!json(find).includes("CANARY-EVENT-X"), "search tenant 1 thấy label sự kiện tenant 2");
      const find2 = await answerQuestion(`tìm ${prefix}`, s2);
      assert.ok(json(find2).includes("CANARY-EVENT-X"), "tenant 2 phải tìm thấy sự kiện của mình");
    });

    await t.test("session tenant 2 thấy camera canary của mình", async () => {
      const a = await answerQuestion("Camera 99 hôm nay có bao nhiêu khách?", s2);
      assert.ok(json(a).includes(CANARY.name));
      assert.ok(json(a).includes(CANARY.location));
      assert.equal(a.value, 3);
    });

    await t.test("hai tenant cùng code CAM-88 → mỗi tenant chỉ thấy camera của mình", async () => {
      const a1 = await answerQuestion("Camera 88 hôm nay có bao nhiêu khách?", s1);
      assert.ok(json(a1).includes(T1DUP.name) && json(a1).includes(T1DUP.location));
      assert.ok(!json(a1).includes(T2DUP.name) && !json(a1).includes(T2DUP.location));
      const a2 = await answerQuestion("Camera 88 hôm nay có bao nhiêu khách?", s2);
      assert.ok(json(a2).includes(T2DUP.name) && json(a2).includes(T2DUP.location));
      assert.ok(!json(a2).includes(T1DUP.name) && !json(a2).includes(T1DUP.location));
    });

    await t.test("tenant 2 có CAM-01 riêng → tenant 1 không thấy marker của nó", async () => {
      const a1 = await answerQuestion("Camera 1 hôm nay có bao nhiêu khách?", s1);
      assert.ok(!json(a1).includes(T2DOOR.name) && !json(a1).includes(T2DOOR.location));
      const a2 = await answerQuestion("Camera 1 hôm nay có bao nhiêu khách?", s2);
      assert.ok(json(a2).includes(T2DOOR.name) && json(a2).includes(T2DOOR.location));
    });
  } finally {
    if (camIds.length) {
      await db.delete(events).where(inArray(events.cameraId, camIds));
      await db.delete(cameras).where(inArray(cameras.id, camIds));
    }
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    if (tenant2Id) await db.delete(tenants).where(eq(tenants.id, tenant2Id));
  }
});
