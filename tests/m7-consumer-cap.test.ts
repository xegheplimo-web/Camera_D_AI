import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLimiter } from "../src/lib/stream-limiter";

/**
 * M7 — cap consumer MJPEG phía app: mỗi tab xem trực tiếp giữ một ffmpeg/relay,
 * nên process phải tự chặn ở MAX_CONSUMERS thay vì để MediaMTX gánh một mình.
 *   - createLimiter: acquire trả false và KHÔNG tăng active khi đã ở max;
 *     release nhả slot; release kép không làm count tụt âm; max <= 0 / không
 *     hữu hạn = unlimited (chế độ tắt cap công khai, không âm thầm).
 *   - Wiring guard rẻ: đọc route.ts dạng text, khẳng định route đọc
 *     MAX_CONSUMERS, gọi acquire() và trả 429 kèm Retry-After.
 * Suite hermetic: không network, không ffmpeg, không DB.
 */
test("m7(a): createLimiter(2) — hai acquire qua, cái thứ ba bị chặn, release mở lại slot", () => {
  const l = createLimiter(2);
  assert.equal(l.max, 2);
  assert.equal(l.active, 0);
  assert.equal(l.acquire(), true);
  assert.equal(l.acquire(), true);
  assert.equal(l.active, 2);
  assert.equal(l.acquire(), false, "acquire thứ ba phải bị từ chối khi đã ở max");
  assert.equal(l.active, 2, "acquire fail không được tăng active — active không bao giờ vượt max");
  l.release();
  assert.equal(l.active, 1);
  assert.equal(l.acquire(), true, "slot vừa nhả phải acquire lại được");
  assert.equal(l.active, 2);
  assert.equal(l.acquire(), false);
  assert.ok(l.active <= l.max);
});

test("m7(b): release kép không làm active tụt xuống âm", () => {
  const l = createLimiter(1);
  assert.equal(l.acquire(), true);
  l.release();
  l.release(); // double release — không được corrupt count
  assert.equal(l.active, 0, "active không được âm sau release kép");
  assert.equal(l.acquire(), true, "count còn đúng ⇒ slot mới vẫn cấp bình thường");
  assert.equal(l.active, 1);
  // Release thừa khi không ai giữ slot cũng phải an toàn.
  const idle = createLimiter(3);
  idle.release();
  assert.equal(idle.active, 0);
});

test("m7(c): createLimiter(0)/(-1)/(không hữu hạn) = unlimited — acquire luôn true", () => {
  for (const max of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const l = createLimiter(max);
    for (let i = 0; i < 50; i++) assert.equal(l.acquire(), true, `max=${max} phải là unlimited`);
    assert.equal(l.max, max);
    // Unlimited vẫn đếm active để quan sát; release vẫn không tụt âm.
    assert.equal(l.active, 50);
    for (let i = 0; i < 60; i++) l.release();
    assert.equal(l.active, 0);
  }
});

test("m7(d): route stream có wiring cap — MAX_CONSUMERS + 429 Retry-After", () => {
  const routePath = fileURLToPath(new URL("../src/app/api/cameras/[id]/stream/route.ts", import.meta.url));
  const src = readFileSync(routePath, "utf8");
  assert.match(src, /MAX_CONSUMERS/, "route phải đọc env MAX_CONSUMERS");
  assert.match(src, /createLimiter\(/, "route phải giữ một limiter module-level");
  assert.match(src, /\.acquire\(\)/, "route phải acquire() trước khi mở stream");
  assert.match(src, /\.release\(\)|releaseOnce\(\)/, "route phải release slot khi stream đóng/lỗi");
  assert.match(src, /429/, "route phải trả 429 khi hết slot");
  assert.match(src, /Quá nhiều kết nối xem trực tiếp/, "429 phải kèm title tiếng Việt đúng spec");
  assert.match(src, /Retry-After/, "429 phải kèm Retry-After");
});
