import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_LOCAL_CLIP_SECONDS,
  createLocalRecorder,
  pickMimeType,
  recordingFileName,
  type LocalRecorderDeps,
} from "../src/lib/camera/local-recorder";

/**
 * P4 — "Ghi vào máy": browser ghi view đang xem thành file trên máy người dùng.
 * Module framework-free, mọi phụ thuộc inject qua LocalRecorderDeps nên suite
 * chạy thuần node (không browser, không DB):
 *   - pickMimeType: thứ tự ưu tiên và trường hợp null.
 *   - recordingFileName: ASCII-safe, không '/', '\', '..', ký tự điều khiển;
 *     stamp YYYYMMDD-HHmmss từ startedAt.
 *   - createLocalRecorder: start idempotent (không recorder thứ hai), stop()
 *     không-start là no-op, chunks nối thành đúng một Blob → deliver(blob,name)
 *     đúng một lần; recorder không data ⇒ không deliver; mime null ⇒ ok:false
 *     có reason; elapsedSeconds() dùng now inject ⇒ auto-stop ở trần test được
 *     bằng clock giả.
 *   - Wiring guard rẻ: nút gắn trong CameraView, component dùng
 *     captureStream + <a download>, route tạo camera bật recordEnabled,
 *     module không ghi đĩa.
 */

const MIME_ALL = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4",
];

class FakeRecorder {
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state = "inactive";
  started = 0;
  stopped = 0;
  constructor(readonly stream: MediaStream, readonly mime: string) {}
  start() {
    this.started++;
    this.state = "recording";
  }
  emit(data: Blob) {
    this.ondataavailable?.({ data });
  }
  stop() {
    this.stopped++;
    this.state = "inactive";
    this.onstop?.();
  }
}

function makeDeps() {
  const recorders: FakeRecorder[] = [];
  const delivered: { blob: Blob; fileName: string }[] = [];
  const state = { clock: 1_700_000_000_000, streamStops: 0 };
  const deps: LocalRecorderDeps = {
    startStream: () => ({ stream: {} as MediaStream, stop: () => { state.streamStops++; } }),
    recorderFactory: (stream, mime) => {
      const r = new FakeRecorder(stream, mime);
      recorders.push(r);
      return r;
    },
    deliver: (blob, fileName) => {
      delivered.push({ blob, fileName });
    },
    now: () => state.clock,
  };
  return { deps, recorders, delivered, state };
}

test("p4(a): pickMimeType — thứ tự ưu tiên vp9 → vp8 → webm → mp4/h264 → null", () => {
  const supported = (allow: (t: string) => boolean) => (t: string) => allow(t) && MIME_ALL.includes(t);
  assert.equal(pickMimeType(supported(() => true)), "video/webm;codecs=vp9");
  assert.equal(pickMimeType(supported((t) => !t.includes("vp9"))), "video/webm;codecs=vp8");
  assert.equal(pickMimeType(supported((t) => !t.includes("codecs"))), "video/webm");
  assert.equal(pickMimeType(supported((t) => t.startsWith("video/mp4"))), "video/mp4;codecs=avc1");
  assert.equal(pickMimeType(supported((t) => t === "video/mp4")), "video/mp4");
  assert.equal(pickMimeType(() => false), null);
});

test("p4(b): recordingFileName — ASCII-safe, không separator/'..'/control, stamp YYYYMMDD-HHmmss", () => {
  const d = new Date(2026, 10, 5, 3, 4, 7);
  const name = recordingFileName("Cổng chính — Đông 2", d);
  assert.equal(name, "cong-chinh-dong-2_20261105-030407.webm");
  assert.match(name, /^[a-z0-9-]+_\d{8}-\d{6}\.webm$/);
  assert.ok(name.includes("20261105-030407"), "tên file phải chứa stamp YYYYMMDD-HHmmss");
  // Tên camera độc hại không được lọt path traversal hay ký tự điều khiển.
  for (const bad of ["../../etc/passwd", "a\\b/c", "x\r\ny", ".."]) {
    const n = recordingFileName(bad, d);
    assert.ok(!n.includes(".."), `'${bad}' lọt '..' vào file name`);
    assert.ok(!/[\\/]/.test(n), `'${bad}' lọt path separator vào file name`);
    assert.ok(!/[\x00-\x1f\x7f]/.test(n), `'${bad}' lọt control char vào file name`);
    assert.ok(/^[\x20-\x7e]+$/.test(n), `'${bad}' ⇒ tên file không ASCII`);
  }
  // Tên rỗng / toàn ký tự lạ vẫn có fallback đọc được.
  assert.match(recordingFileName("   ", d), /^camera_\d{8}-\d{6}\.webm$/);
  assert.match(recordingFileName("!!!", d), /^camera_\d{8}-\d{6}\.webm$/);
});

test("p4(c): start→stop deliver đúng một Blob nối bytes; start kép không mở recorder thứ hai", async () => {
  const f = makeDeps();
  const rec = createLocalRecorder(f.deps, "Cam A", "video/webm");
  assert.equal(rec.state(), "idle");
  assert.deepEqual(rec.start(), { ok: true });
  assert.equal(rec.state(), "recording");
  assert.deepEqual(rec.start(), { ok: true }, "start() lần hai là no-op, không phải lỗi");
  assert.equal(f.recorders.length, 1, "start() lần hai không được mở recorder mới");
  f.recorders[0].emit(new Blob([new Uint8Array([1, 2, 3])]));
  f.recorders[0].emit(new Blob([new Uint8Array([4, 5])]));
  rec.stop();
  assert.equal(rec.state(), "idle");
  assert.equal(f.delivered.length, 1, "deliver() phải được gọi đúng một lần");
  const bytes = new Uint8Array(await f.delivered[0].blob.arrayBuffer());
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5], "chunks phải nối giữ nguyên thứ tự bytes");
  assert.match(f.delivered[0].fileName, /^cam-a_\d{8}-\d{6}\.webm$/);
  assert.equal(f.recorders[0].stopped, 1);
  assert.equal(f.state.streamStops, 1, "stream phải được nhả sau khi dừng");
});

test("p4(d): recorder không data ⇒ không deliver gì, state() vẫn về idle", () => {
  const f = makeDeps();
  const rec = createLocalRecorder(f.deps, "Cam", "video/webm");
  rec.start();
  rec.stop(); // không emit chunk nào
  assert.equal(rec.state(), "idle");
  assert.equal(f.delivered.length, 0, "recorder không data ⇒ deliver() không được gọi");
});

test("p4(e): mime null (pickMimeType = null) ⇒ start() trả ok:false kèm reason, không ghi", () => {
  const f = makeDeps();
  const rec = createLocalRecorder(f.deps, "Cam", null);
  const r = rec.start();
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.length > 0, "ok:false phải kèm reason đọc được");
  assert.equal(f.recorders.length, 0, "không được tạo recorder khi mime không hỗ trợ");
  assert.equal(f.delivered.length, 0);
  assert.equal(rec.state(), "idle");
});

test("p4(f): elapsedSeconds() dùng now inject ⇒ auto-stop ở MAX_LOCAL_CLIP_SECONDS", () => {
  assert.equal(MAX_LOCAL_CLIP_SECONDS, 600);
  const f = makeDeps();
  const rec = createLocalRecorder(f.deps, "Cam", "video/webm");
  rec.start();
  f.recorders[0].emit(new Blob([new Uint8Array([9])]));
  f.state.clock += 5_000;
  assert.equal(rec.elapsedSeconds(), 5, "elapsed phải đi theo clock inject");
  f.state.clock += (MAX_LOCAL_CLIP_SECONDS - 5 + 1) * 1000;
  const elapsed = rec.elapsedSeconds();
  assert.ok(elapsed >= MAX_LOCAL_CLIP_SECONDS);
  assert.equal(rec.state(), "idle", "quá trần MAX_LOCAL_CLIP_SECONDS phải tự dừng");
  assert.equal(f.delivered.length, 1, "auto-stop vẫn phải deliver clip đã ghi");
});

test("p4(g): stop() khi chưa start là no-op — không ném, không deliver", () => {
  const f = makeDeps();
  const rec = createLocalRecorder(f.deps, "Cam", "video/webm");
  assert.doesNotThrow(() => rec.stop());
  assert.equal(rec.state(), "idle");
  assert.equal(f.delivered.length, 0);
  assert.equal(f.state.streamStops, 0);
});

test("p4(h): wiring guard — nút trong CameraView, captureStream + <a download>, route bật ghi, module không ghi đĩa", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  assert.match(read("../src/components/CameraView.tsx"), /LocalRecordButton/, "CameraView phải gắn LocalRecordButton");
  const btn = read("../src/components/LocalRecordButton.tsx");
  assert.match(btn, /captureStream/, "MJPEG <img> phải qua canvas.captureStream");
  assert.match(btn, /download/, "phải đưa file qua <a download> cho trình duyệt hỏi nơi lưu");
  assert.match(read("../src/app/api/cameras/route.ts"), /recordEnabled\s*:\s*true/, "camera mới phải mặc định bật ghi");
  assert.doesNotMatch(
    read("../src/lib/camera/local-recorder.ts"),
    /node:fs|from\s+["']fs["']|require\(["']fs["']\)|showDirectoryPicker|showSaveFilePicker|runtime\/recordings/,
    "module 'ghi vào máy' không được tự ghi đĩa",
  );
});
