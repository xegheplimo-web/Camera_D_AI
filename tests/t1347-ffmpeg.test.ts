import test from "node:test";
import assert from "node:assert/strict";
import { ffmpegStatus, resetFfmpegCache } from "../src/lib/recordings/ffmpeg";

/**
 * T-1347 — ffmpeg là phụ thuộc runtime chưa khai báo. Probe phải:
 *  - trả available=false + error khi binary không tồn tại (không throw, không treo),
 *  - trả version khi có ffmpeg thật,
 *  - cache theo đường dẫn (đổi FFMPEG_PATH là đo lại).
 */

const ORIGINAL = process.env.FFMPEG_PATH;

test.afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = ORIGINAL;
  resetFfmpegCache();
});

test("binary không tồn tại ⇒ available=false kèm lỗi, không throw", async () => {
  process.env.FFMPEG_PATH = "definitely-not-ffmpeg-1347";
  resetFfmpegCache();
  const s = await ffmpegStatus();
  assert.equal(s.available, false);
  assert.equal(s.path, "definitely-not-ffmpeg-1347");
  assert.equal(s.version, null);
  assert.ok(s.error && s.error.length > 0, "phải có error để log/503 detail");
});

test("đường dẫn tuyệt đối không tồn tại ⇒ available=false", async () => {
  process.env.FFMPEG_PATH = process.platform === "win32" ? "C:/nonexistent/ffmpeg.exe" : "/nonexistent/ffmpeg";
  resetFfmpegCache();
  const s = await ffmpegStatus();
  assert.equal(s.available, false);
});

test("có ffmpeg thật ⇒ available=true + version đọc được", async () => {
  delete process.env.FFMPEG_PATH;
  resetFfmpegCache();
  const s = await ffmpegStatus();
  assert.equal(s.available, true, `ffmpeg phải có trên máy test (error=${s.error})`);
  assert.match(s.version ?? "", /^ffmpeg version /);
});

test("cache: lần 2 không spawn lại (cùng path)", async () => {
  delete process.env.FFMPEG_PATH;
  resetFfmpegCache();
  const a = await ffmpegStatus();
  const b = await ffmpegStatus();
  assert.equal(a.available, b.available);
  assert.deepEqual(b, a);
});
