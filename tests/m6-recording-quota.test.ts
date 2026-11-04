import "dotenv/config";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { db, pool } from "../src/db";
import { auditLog } from "../src/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { enforceRecordingQuota, selectOldestToDelete } from "../src/lib/recordings";

/**
 * M6 — quota dung lượng bản ghi theo camera: một camera không được phép lấp đĩa.
 *   - selectOldestToDelete (thuần): dưới cap ⇒ []; quá cap ⇒ xoá CŨ NHẤT trước
 *     tới khi <= cap; KHÔNG BAO GIỜ đụng file mới nhất (segment đang ghi); cap
 *     <= 0 ⇒ tắt.
 *   - enforceRecordingQuota trên thư mục tạm đúng layout <key>/<date>/<seg>.mp4:
 *     cap áp theo TỪNG camera key; trả {deleted, bytes, capped} khớp byte thực
 *     giải phóng; ghi 1 audit row "recording.quota_prune" cho mỗi key bị cắt.
 * Suite hermetic: mọi file nằm trong mkdtemp, dọn trong finally; audit row
 * fixture xoá trong after(). TUYỆT ĐỐI không đụng RECORDINGS_DIR thật.
 */
const prefix = `m6q_${randomBytes(4).toString("hex")}`;
const quotaKeys: string[] = []; // targetId audit cần dọn

function seg(dir: string, name: string, size: number, mtime: Date) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f, Buffer.alloc(size, 7));
  utimesSync(f, mtime, mtime);
  return f;
}

const quotaAuditRows = (keys: string[]) =>
  db
    .select({ targetId: auditLog.targetId, actor: auditLog.actor, tenantId: auditLog.tenantId, detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.action, "recording.quota_prune"), inArray(auditLog.targetId, keys)));

after(async () => {
  if (quotaKeys.length) {
    await db.delete(auditLog).where(and(eq(auditLog.action, "recording.quota_prune"), inArray(auditLog.targetId, quotaKeys)));
  }
  await pool.end();
});

test("m6(a): selectOldestToDelete — đã dưới cap ⇒ không xoá gì", () => {
  const f = (name: string, size: number, mtimeMs: number) => ({ path: `/r/k/${name}`, size, mtimeMs });
  assert.deepEqual(selectOldestToDelete([f("a", 100, 1), f("b", 100, 2)], 500), []);
  assert.deepEqual(selectOldestToDelete([f("a", 100, 1), f("b", 100, 2)], 200), []); // total == cap
  assert.deepEqual(selectOldestToDelete([], 100), []); // input rỗng
});

test("m6(b): selectOldestToDelete — quá cap ⇒ cũ nhất trước, dừng ở cap, file mới nhất tuyệt đối giữ", () => {
  const files = [
    { path: "/r/k/old", size: 500, mtimeMs: 1 },
    { path: "/r/k/mid", size: 300, mtimeMs: 2 },
    { path: "/r/k/new", size: 200, mtimeMs: 3 }, // mới nhất — không bao giờ bị chọn
  ];
  // cap 600: xoá old (500) ⇒ còn 500 <= 600 ⇒ dừng.
  assert.deepEqual(selectOldestToDelete(files, 600), [{ path: "/r/k/old", size: 500 }]);
  // cap 400: xoá old+mid ⇒ còn 200 <= 400.
  assert.deepEqual(selectOldestToDelete(files, 400), [
    { path: "/r/k/old", size: 500 },
    { path: "/r/k/mid", size: 300 },
  ]);
  // cap 100: xoá hết trừ new vẫn > cap — new vẫn phải giữ.
  assert.deepEqual(selectOldestToDelete(files, 100), [
    { path: "/r/k/old", size: 500 },
    { path: "/r/k/mid", size: 300 },
  ]);
});

test("m6(c): selectOldestToDelete — cap 0/âm/NaN ⇒ tắt, không xoá gì", () => {
  const files = [{ path: "/r/k/a", size: 100, mtimeMs: 1 }, { path: "/r/k/b", size: 100, mtimeMs: 2 }];
  assert.deepEqual(selectOldestToDelete(files, 0), []);
  assert.deepEqual(selectOldestToDelete(files, -50), []);
  assert.deepEqual(selectOldestToDelete(files, Number.NaN), []);
});

test("m6(d): enforceRecordingQuota — quá quota xoá cũ nhất, giữ segment đang ghi, theo từng key", async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-m6q-"));
  const keyOver = `${prefix}_over`, keyUnder = `${prefix}_under`;
  quotaKeys.push(keyOver, keyUnder);
  const now = Date.now();
  try {
    // Layout thật <key>/<date>/<segment>.mp4 — 600B trong keyOver, cap 450.
    const dOver = join(root, keyOver, "2026-11-05");
    const fOld = seg(dOver, "2026-11-05_01-00-00-000000.mp4", 300, new Date(now - 3 * 3600e3));
    const fMid = seg(dOver, "2026-11-05_02-00-00-000000.mp4", 200, new Date(now - 2 * 3600e3));
    const fNew = seg(dOver, "2026-11-05_03-00-00-000000.mp4", 100, new Date(now - 1 * 3600e3));
    // Key thứ hai dưới cap — chứng minh quota áp PER camera key, không phải global.
    const fKeep = seg(join(root, keyUnder, "2026-11-05"), "2026-11-05_02-00-00-000000.mp4", 400, new Date(now - 2 * 3600e3));

    const r = await enforceRecordingQuota({ dir: root, capBytes: 450 });
    assert.equal(r.deleted, 1);
    assert.equal(r.bytes, 300, "bytes phải khớp đúng dung lượng thực giải phóng");
    assert.equal(r.capped, 1, "chỉ keyOver bị cắt quota");
    assert.ok(!existsSync(fOld), "file cũ nhất phải bị xoá");
    assert.ok(existsSync(fMid) && existsSync(fNew), "segment mới nhất (đang ghi) + file giữa phải còn");
    assert.ok(existsSync(fKeep), "key dưới cap không bị đụng");

    // Đúng 1 audit row recording.quota_prune cho keyOver, actor system.
    const rows = await quotaAuditRows([keyOver, keyUnder]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].targetId, keyOver);
    assert.equal(rows[0].actor, "system");
    assert.equal(rows[0].tenantId, null, "key temp không map camera nào ⇒ tenant NULL");
    assert.match(rows[0].detail ?? "", /deleted=1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.ok(!existsSync(root), "thư mục tạm phải được dọn trong finally");
  }
});

test("m6(e): enforceRecordingQuota — dưới quota không xoá, không audit; cap <= 0 ⇒ tắt", async () => {
  const root = mkdtempSync(join(tmpdir(), "dai-m6q-"));
  const key = `${prefix}_ok`;
  quotaKeys.push(key);
  try {
    const f = seg(join(root, key, "2026-11-05"), "2026-11-05_02-00-00-000000.mp4", 100, new Date());
    const under = await enforceRecordingQuota({ dir: root, capBytes: 10_000 });
    assert.deepEqual(under, { deleted: 0, bytes: 0, capped: 0 });
    const disabled = await enforceRecordingQuota({ dir: root, capBytes: 0 });
    assert.deepEqual(disabled, { deleted: 0, bytes: 0, capped: 0 });
    assert.ok(existsSync(f));
    assert.equal((await quotaAuditRows([key])).length, 0, "không xoá ⇒ không ghi audit");
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.ok(!existsSync(root), "thư mục tạm phải được dọn trong finally");
  }
});
