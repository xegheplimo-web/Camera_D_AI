import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { db, pool } from "../src/db";
import { tenants, users, sessions, cameras, appSettings } from "../src/db/schema";
import { eq, inArray, like } from "drizzle-orm";
import { moveTile, normalizeLayout, WALL_MAX, type WallTile } from "../src/lib/wall/layout";
import { loadWallLayout, saveWallLayout, wallLayoutKey } from "../src/lib/wall/store";

/**
 * P3 — tường camera.
 *   - normalizeLayout (thuần): drop id lạ/ngoài validIds, de-dupe, kẹp
 *     WALL_MAX, sort theo order và luôn trả order dày 0..n-1; input méo
 *     (null/[]/"x"/{}) ⇒ [] không ném.
 *   - moveTile (thuần): dời + đánh lại order dày; chỉ số ngoài phạm vi ⇒
 *     trả y nguyên layout.
 *   - DB round-trip qua store (key `wall:tenant:<t>:user:<u>`): lưu rồi đọc
 *     y hệt; user/tenant khác không thấy; id camera ngoài tenant bị drop,
 *     không nằm trong payload đã lưu.
 *   - Wiring guard: route /snapshot không được acquire slot MAX_CONSUMERS.
 * Suite hermetic: không spawn server, không go2rtc; fixture tenant/user/
 * camera riêng theo prefix, dọn hết trong after().
 */
const prefix = `p3_${randomBytes(5).toString("hex")}`;
let tA = 0, tB = 0, uA = 0, uB = 0;
let camA1 = 0, camA2 = 0, camA3 = 0, camB1 = 0;
const tenantIds: number[] = [];
const userIds: number[] = [];
const cameraIds: number[] = [];

before(async () => {
  const ts = await db
    .insert(tenants)
    .values([{ slug: `${prefix}-a`, name: `${prefix} A` }, { slug: `${prefix}-b`, name: `${prefix} B` }])
    .returning({ id: tenants.id });
  [tA, tB] = ts.map((x) => x.id);
  tenantIds.push(tA, tB);

  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync("x", salt, 64).toString("hex")}`;
  const us = await db
    .insert(users)
    .values([
      { login: `${prefix}_ua`, displayName: `${prefix}_ua`, role: "owner", passwordHash, tenantId: tA },
      { login: `${prefix}_ub`, displayName: `${prefix}_ub`, role: "viewer", passwordHash, tenantId: tA },
    ])
    .returning({ id: users.id });
  [uA, uB] = us.map((u) => u.id);
  userIds.push(uA, uB);

  const cs = await db
    .insert(cameras)
    .values([
      { tenantId: tA, code: `${prefix}_a1`, name: `${prefix} A1`, location: "loc-a1" },
      { tenantId: tA, code: `${prefix}_a2`, name: `${prefix} A2`, location: "loc-a2" },
      { tenantId: tA, code: `${prefix}_a3`, name: `${prefix} A3`, location: "loc-a3" },
      { tenantId: tB, code: `${prefix}_b1`, name: `${prefix} B1`, location: "loc-b1" },
    ])
    .returning({ id: cameras.id });
  [camA1, camA2, camA3, camB1] = cs.map((c) => c.id);
  cameraIds.push(camA1, camA2, camA3, camB1);
});

after(async () => {
  try {
    for (const t of tenantIds) {
      await db.delete(appSettings).where(like(appSettings.key, `wall:tenant:${t}:%`));
    }
    if (cameraIds.length) await db.delete(cameras).where(inArray(cameras.id, cameraIds));
    if (userIds.length) {
      await db.delete(sessions).where(inArray(sessions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  } finally {
    await pool.end();
  }
});

test("p3(a): normalizeLayout — drop id lạ, de-dupe (giữ bản đầu), sort theo order, order dày", () => {
  const out = normalizeLayout(
    [
      { cameraId: 2, order: 7 },
      { cameraId: 9, order: 0 }, // id ngoài validIds
      { cameraId: 1, order: 3 },
      { cameraId: 2, order: 1 }, // trùng cameraId=2 — bản sau bị bỏ
      { cameraId: 4, order: 2 },
      { cameraId: "x", order: -1 }, // cameraId méo
    ],
    [1, 2, 3, 4],
  );
  assert.deepEqual(out, [
    { cameraId: 4, order: 0 },
    { cameraId: 1, order: 1 },
    { cameraId: 2, order: 2 },
  ]);
});

test("p3(b): normalizeLayout — kẹp WALL_MAX và luôn trả order dày 0..n-1", () => {
  const n = WALL_MAX + 5;
  const raw = Array.from({ length: n }, (_, i) => ({ cameraId: i + 1, order: n - i })); // order ngược
  const out = normalizeLayout(raw, raw.map((t) => t.cameraId));
  assert.equal(out.length, WALL_MAX, "không được vượt WALL_MAX");
  assert.deepEqual(out.map((t) => t.order), Array.from({ length: WALL_MAX }, (_, i) => i), "order phải dày 0..n-1");
  // Giữ WALL_MAX tile có order nhỏ nhất: order=n-i ⇒ tile i cuối (order 1..16) ⇒ cameraId n..n-15.
  assert.equal(out[0].cameraId, n);
  assert.equal(out[WALL_MAX - 1].cameraId, n - WALL_MAX + 1);
});

test("p3(c): normalizeLayout — input méo ⇒ [], không ném", () => {
  for (const bad of [null, undefined, [], "x", {}, 7, Number.NaN]) {
    assert.deepEqual(normalizeLayout(bad, [1, 2]), [], `input ${JSON.stringify(bad)} phải ⇒ []`);
  }
  // Phần tử không phải tile hợp lệ đều bị bỏ — kể cả cameraId lẻ/âm/thiếu.
  assert.deepEqual(normalizeLayout([null, "x", { order: 1 }, { cameraId: 1.5, order: 0 }, { cameraId: -2, order: 0 }], [1, 2]), []);
  // order méo ⇒ tile vẫn giữ, xếp theo vị trí mảng rồi densify.
  assert.deepEqual(normalizeLayout([{ cameraId: 3, order: "x" }, { cameraId: 1, order: 0 }], [1, 3]), [
    { cameraId: 3, order: 0 },
    { cameraId: 1, order: 1 },
  ]);
});

test("p3(d): moveTile — dời và đánh lại order dày; chỉ số lỗi là no-op", () => {
  const L: WallTile[] = [
    { cameraId: 1, order: 0 },
    { cameraId: 2, order: 1 },
    { cameraId: 3, order: 2 },
    { cameraId: 4, order: 3 },
  ];
  const fwd = moveTile(L, 0, 2);
  assert.deepEqual(fwd.map((t) => t.cameraId), [2, 3, 1, 4]);
  assert.deepEqual(fwd.map((t) => t.order), [0, 1, 2, 3], "order phải densify sau khi dời");
  assert.deepEqual(moveTile(L, 3, 0).map((t) => t.cameraId), [4, 1, 2, 3]);
  for (const [f, to] of [[-1, 0], [0, -1], [0, 4], [4, 0], [1.5, 0], [0, Number.NaN]] as const) {
    assert.equal(moveTile(L, f, to), L, `moveTile(${f},${to}) phải trả y nguyên layout`);
  }
  assert.equal(moveTile(L, 0, 0), L, "from===to là no-op");
});

test("p3(e): DB round-trip — lưu/đọc y hệt, cô lập theo (tenant,user), id ngoài tenant không được lưu", async () => {
  const idsA = [camA1, camA2, camA3];
  assert.equal(wallLayoutKey(7, 42), "wall:tenant:7:user:42", "format key app_settings phải đúng spec");

  try {
    const saved = await saveWallLayout(tA, uA, [{ cameraId: camA2, order: 0 }, { cameraId: camA1, order: 1 }], idsA);
    assert.deepEqual(saved, [{ cameraId: camA2, order: 0 }, { cameraId: camA1, order: 1 }]);

    const back = await loadWallLayout(tA, uA, idsA);
    assert.deepEqual(back, saved, "đọc lại phải y hệt payload đã lưu");

    // User khác cùng tenant ⇒ key khác ⇒ không thấy layout của uA.
    assert.equal(await loadWallLayout(tA, uB, idsA), null, "user khác không được thấy layout này");
    // Tenant khác (dù cùng userId) ⇒ key khác ⇒ không thấy.
    assert.equal(await loadWallLayout(tB, uA, [camB1]), null, "tenant khác không được thấy layout này");

    // PUT với camera của tenant B trong payload: id ngoài tenant bị drop, không lưu.
    const dirty = await saveWallLayout(tA, uB, [{ cameraId: camB1, order: 0 }, { cameraId: camA3, order: 1 }], idsA);
    assert.deepEqual(dirty, [{ cameraId: camA3, order: 0 }], "id ngoài tenant phải bị drop khỏi kết quả");
    const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, wallLayoutKey(tA, uB)));
    assert.ok(row, "phải có hàng app_settings cho key của uB");
    const stored = (row.value as { tiles?: { cameraId: number }[] }).tiles ?? [];
    assert.ok(!stored.some((t) => t.cameraId === camB1), "id camera tenant khác không được nằm trong payload đã lưu");
    assert.ok(stored.some((t) => t.cameraId === camA3));
  } finally {
    // Dọn mọi hàng wall suite đã ghi — kể cả khi assert giữa chừng fail.
    for (const t of tenantIds) {
      await db.delete(appSettings).where(like(appSettings.key, `wall:tenant:${t}:%`));
    }
  }
});

test("p3(f): route /snapshot KHÔNG acquire slot MAX_CONSUMERS và trả image/jpeg no-store", () => {
  const p = fileURLToPath(new URL("../src/app/api/cameras/[id]/snapshot/route.ts", import.meta.url));
  const src = readFileSync(p, "utf8");
  assert.ok(!/createLimiter|\.acquire\(\)/.test(src), "snapshot không được chiếm slot của stream-limiter");
  assert.match(src, /image\/jpeg/, "route phải trả Content-Type image/jpeg");
  assert.match(src, /no-store/, "route phải Cache-Control: no-store");
  assert.match(src, /FFD8|0xff,\s*0xd8|0xFF,\s*0xD8/i, "route phải tìm marker SOI FFD8");
});
