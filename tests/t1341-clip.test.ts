import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClipArgs, buildConcatManifest, ffmpegPath, pickClipSegments, validateClipRange } from "../src/lib/recordings/clip";

/**
 * T-1341 — clip from→to bằng stream copy: unit cho validate/pick/args + test
 * thật trên ffmpeg (tạo 2 segment testsrc2 10 s, cắt [+3s,+7s] → h264 ~4 s,
 * ghép 2 segment bằng concat demuxer → h264 ~6 s). Không có ffmpeg/ffprobe ⇒
 * FAIL rõ ràng (không skip im lặng) vì máy thật cần ffmpeg để xuất clip.
 */
const dir = mkdtempSync(join(tmpdir(), "dai-t1341-"));

after(() => rmSync(dir, { recursive: true, force: true }));

function ffmpeg(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(ffmpegPath(), args, { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.error, undefined, `spawn ffmpeg lỗi: ${r.error?.message}`);
  return { status: r.status, stderr: r.stderr ?? "" };
}

function ffprobeJson(path: string): { streams: { codec_name?: string }[]; format: { duration?: string } } {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name:format=duration", "-of", "json", path], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.error, undefined, `spawn ffprobe lỗi: ${r.error?.message}`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/* ================= 1. validateClipRange ================= */

test("unit: validateClipRange — from≥to, >600 s, tương lai, quá cũ → lỗi; hợp lệ → ok", () => {
  const now = new Date("2026-11-03T10:00:00Z");
  const sec = (n: number) => new Date(now.getTime() + n * 1000);

  assert.equal(validateClipRange({ from: now, to: now }, now).ok, false, "from == to");
  assert.equal(validateClipRange({ from: sec(10), to: now }, now).ok, false, "from > to");
  const tooLong = validateClipRange({ from: sec(-601), to: now }, now);
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.code, "SPAN_TOO_LONG");
  assert.equal(validateClipRange({ from: sec(-600), to: now }, now).ok, true, "đúng 600 s vẫn hợp lệ");
  assert.equal(validateClipRange({ from: sec(-10), to: sec(120) }, now).ok, false, "to vượt now+60 s");
  assert.equal(validateClipRange({ from: sec(-10), to: sec(30) }, now).ok, true, "to trong dung sai 60 s");
  assert.equal(validateClipRange({ from: new Date(now.getTime() - 401 * 86_400_000), to: new Date(now.getTime() - 400 * 86_400_000) }, now).ok, false, "from cũ hơn 400 ngày");
  assert.equal(validateClipRange({ from: sec(-30), to: now }, now).ok, true);
  assert.equal(validateClipRange({ from: new Date(NaN), to: now }, now).ok, false, "from NaN");
});

/* ================= 2. pickClipSegments ================= */

test("unit: pickClipSegments — giao một phần được giữ, nhiều segment sắp tăng dần, loại durationSec ≤ 0", () => {
  const t0 = new Date("2026-11-03T10:00:00Z").getTime();
  const seg = (file: string, offSec: number, durationSec?: number) => ({ file, start: new Date(t0 + offSec * 1000), durationSec });
  const segs = [
    seg("c/3.mp4", 600, 300),
    seg("c/1.mp4", 0, 300),
    seg("c/2.mp4", 300, 300),
    seg("c/dead.mp4", 900, 0),      // duration 0 → loại
    seg("c/nodur.mp4", 1200),       // thiếu duration → loại
    seg("c/far.mp4", 5000, 300),    // ngoài khoảng → loại
  ];
  const r = { from: new Date(t0 + 250_000), to: new Date(t0 + 650_000) };
  const picked = pickClipSegments(segs, r);
  assert.deepEqual(picked.map((s) => s.file), ["c/1.mp4", "c/2.mp4", "c/3.mp4"], "giao một phần vẫn giữ + sắp tăng dần");
  assert.equal(picked[0].durationSec, 300);

  assert.deepEqual(pickClipSegments(segs, { from: new Date(t0 + 900_000), to: new Date(t0 + 1_100_000) }), [], "chỉ trúng segment duration ≤ 0 → rỗng");
  assert.deepEqual(pickClipSegments(segs, { from: new Date(t0 - 10_000), to: new Date(t0) }), [], "to == start segment 1 → không giao (nửa khoảng [from,to))");
});

/* ================= 3. buildClipArgs + buildConcatManifest ================= */

test("unit: buildClipArgs — 1 file: -ss/-t trước -i, -c copy, faststart, pipe:1, không re-encode", () => {
  const args = buildClipArgs({ files: ["/rec/cam/a.mp4"], offsetSec: 3, durationSec: 4 });
  const i = args.indexOf("-i");
  assert.ok(i > 0);
  assert.deepEqual(args.slice(0, i), ["-hide_banner", "-loglevel", "error", "-ss", "3", "-t", "4"]);
  assert.equal(args[i + 1], "/rec/cam/a.mp4");
  assert.deepEqual(args.slice(i + 2), ["-c", "copy", "-movflags", "+faststart", "-f", "mp4", "pipe:1"]);
  const joined = args.join(" ");
  assert.ok(joined.includes("-c copy"), "phải stream copy");
  assert.ok(!/libx264|x264|-c:v|-vf|scale/.test(joined), "cấm mọi dấu hiệu re-encode");
});

test("unit: buildClipArgs — nhiều file: concat demuxer + -safe 0 + -ss/-t sau -i; manifest in/outpoint", () => {
  const list = join(dir, "list.txt");
  const args = buildClipArgs({ files: ["/rec/c/a.mp4", "/rec/c/b.mp4"], offsetSec: 0, durationSec: 6, listFile: list, out: "/tmp/out.mp4" });
  const i = args.indexOf("-i");
  assert.deepEqual(args.slice(3, i), ["-f", "concat", "-safe", "0"], "concat demuxer -safe 0");
  assert.equal(args[i + 1], list);
  assert.deepEqual(args.slice(i + 2, i + 4), ["-t", "6"], "-t áp lên kết quả concat; -ss 0 bị lược vì làm mất ~1 GOP với stream copy");
  assert.ok(args.join(" ").includes("-c copy"));
  assert.ok(!/libx264|-c:v/.test(args.join(" ")));
  assert.equal(args.at(-1), "/tmp/out.mp4");
  assert.throws(() => buildClipArgs({ files: ["a", "b"], offsetSec: 0, durationSec: 6 }), /listFile/);
  const off = buildClipArgs({ files: ["a", "b"], offsetSec: 2.5, durationSec: 6, listFile: "l.txt" });
  assert.ok(off.join(" ").includes("-ss 2.5"), "offset > 0 vẫn emit -ss sau -i");

  const t0 = new Date("2026-11-03T10:00:00Z").getTime();
  const manifest = buildConcatManifest(
    [
      { path: "C:\\rec\\c\\a.mp4", start: new Date(t0), durationSec: 300 },
      { path: "C:\\rec\\c\\b.mp4", start: new Date(t0 + 300_000), durationSec: 300 },
    ],
    { from: new Date(t0 + 295_000), to: new Date(t0 + 302_000) },
  );
  assert.ok(manifest.includes("file 'C:/rec/c/a.mp4'"), "path Windows → forward slash");
  assert.ok(manifest.includes("inpoint 295"), "file 1 cắt lửng đầu");
  assert.ok(manifest.includes("outpoint 2"), "file 2 cắt lửng cuối");
});

/* ================= 4. ffmpeg thật: cắt + concat ================= */

test("real: ffmpeg/ffprobe có sẵn; cắt [+3s,+7s] → h264 ~4 s; concat 2 segment → ~6 s", (t) => {
  const hasFfmpeg = spawnSync(ffmpegPath(), ["-version"], { timeout: 10_000 });
  const hasFfprobe = spawnSync("ffprobe", ["-version"], { timeout: 10_000 });
  assert.equal(hasFfmpeg.error, undefined, "TEST YÊU CẦU ffmpeg trên PATH (hoặc FFMPEG_PATH) — không skip im lặng");
  assert.equal(hasFfprobe.error, undefined, "TEST YÊU CẦU ffprobe trên PATH — không skip im lặng");
  assert.equal(hasFfmpeg.status, 0, "ffmpeg -version phải chạy được");
  assert.equal(hasFfprobe.status, 0, "ffprobe -version phải chạy được");

  // 2 segment 10 s, keyframe mỗi giây (-g 10 @10fps) để stream copy chính xác.
  const startA = new Date(Date.now() - 3600_000);
  const files: string[] = [];
  for (const name of ["seg-a.mp4", "seg-b.mp4"]) {
    const p = join(dir, name);
    const r = ffmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-t", "10", "-c:v", "libx264", "-g", "10", "-pix_fmt", "yuv420p", p]);
    assert.equal(r.status, 0, `tạo fixture ${name}: ${r.stderr.slice(-300)}`);
    assert.ok(existsSync(p));
    files.push(p);
  }
  const segs = files.map((f, i) => ({ file: f, start: new Date(startA.getTime() + i * 10_000), durationSec: 10 }));

  // Đơn segment: [+3s, +7s] → chỉ giao seg-a, offset 3, duration 4.
  const single = pickClipSegments(segs, { from: new Date(startA.getTime() + 3000), to: new Date(startA.getTime() + 7000) });
  assert.equal(single.length, 1, "khoảng [+3,+7] chỉ nằm trong seg-a");
  const out1 = join(dir, "clip-single.mp4");
  const args1 = buildClipArgs({ files: [single[0].file], offsetSec: 3, durationSec: 4, out: out1 });
  assert.ok(args1.join(" ").includes("-c copy") && !/libx264/.test(args1.join(" ")), "clip phải stream copy");
  const r1 = ffmpeg(args1);
  assert.equal(r1.status, 0, `ffmpeg cắt đơn segment: ${r1.stderr.slice(-300)}`);
  const p1 = ffprobeJson(out1);
  assert.equal(p1.streams[0]?.codec_name, "h264", "codec giữ nguyên (không re-encode)");
  const d1 = Number(p1.format.duration);
  assert.ok(d1 >= 3.5 && d1 <= 4.5, `duration=${d1} phải ≈ 4 s`);

  // Ghép: [+7s của a → +3s của b] = 3 s cuối a + 3 s đầu b ≈ 6 s.
  const multiRange = { from: new Date(startA.getTime() + 7000), to: new Date(startA.getTime() + 13_000) };
  const multi = pickClipSegments(segs, multiRange);
  assert.equal(multi.length, 2, "khoảng phải giao cả 2 segment");
  const listPath = join(dir, "clip-list.txt");
  writeFileSync(listPath, buildConcatManifest(multi.map((s) => ({ path: s.file, start: s.start, durationSec: s.durationSec })), multiRange), "utf8");
  const out2 = join(dir, "clip-multi.mp4");
  const args2 = buildClipArgs({ files: multi.map((s) => s.file), offsetSec: 0, durationSec: 6, listFile: listPath, out: out2 });
  const r2 = ffmpeg(args2);
  assert.equal(r2.status, 0, `ffmpeg concat: ${r2.stderr.slice(-300)}`);
  const p2 = ffprobeJson(out2);
  assert.equal(p2.streams[0]?.codec_name, "h264");
  const d2 = Number(p2.format.duration);
  assert.ok(d2 >= 5.5 && d2 <= 6.5, `duration=${d2} phải ≈ 6 s (3 s cuối a + 3 s đầu b)`);
  void t;
});
