import test from "node:test";
import assert from "node:assert/strict";
import { applyPreset, taskPreset } from "../src/lib/extract-presets";
import { streamBadge, listStatus } from "../src/lib/camera/status";
import { answerBasedOnDemo } from "../src/lib/chat-demo";

// T-1318 mục 1 — preset phải điền được ghi chú, nhưng không ghi đè chữ người dùng tự sửa.
test("preset điền ghi chú khi ô trống, và thay khi ô đang là preset trước đó", () => {
  const ocr = taskPreset("ocr")!.note;
  const plate = taskPreset("plate")!.note;
  let r = applyPreset("", null, ocr);
  assert.equal(r.note, ocr);
  assert.equal(r.applied, ocr);
  r = applyPreset("   ", r.applied, plate);
  assert.equal(r.note, plate);
  r = applyPreset(r.note, r.applied, ocr);
  assert.equal(r.note, ocr);
});

test("preset không ghi đè ghi chú người dùng đã sửa tay", () => {
  const first = applyPreset("", null, taskPreset("ocr")!.note);
  const edited = "Chỉ đọc dòng chữ đỏ góc trên";
  const r = applyPreset(edited, first.applied, taskPreset("describe")!.note);
  assert.equal(r.note, edited);
  assert.equal(r.applied, taskPreset("describe")!.note);
});

// T-1318 mục 3 — webcam là nguồn trình duyệt: không dùng nhãn "Trực tiếp"/"offline" của pipeline RTSP.
test("webcam có nhãn và trạng thái riêng, không gọi là Trực tiếp", () => {
  assert.equal(streamBadge("webcam", "live"), "Webcam trên trình duyệt · Đang bật");
  assert.equal(streamBadge("webcam", "off"), "Webcam trên trình duyệt · Chưa bật");
  assert.equal(streamBadge("webcam", "connecting"), "Đang kết nối…");
  assert.equal(streamBadge("rtsp", "live"), "Trực tiếp");
  assert.equal(streamBadge("rtsp", "off"), "Camera IP chưa có hình");
  assert.equal(streamBadge("demo", "live"), "Nguồn mô phỏng");
});

test("danh sách camera: webcam DB offline không hiển thị Offline; nguồn demo ghi Mô phỏng", () => {
  const webcam = listStatus({ sourceType: "webcam", status: "offline" });
  assert.equal(webcam.label, "Trên trình duyệt");
  assert.equal(webcam.tone, "muted");
  assert.equal(listStatus({ sourceType: "demo", status: "demo" }).label, "Mô phỏng");
  assert.equal(listStatus({ sourceType: "rtsp", status: "degraded", streamName: "dai_cam_1" }).label, "Đã đăng ký");
  assert.equal(listStatus({ sourceType: "rtsp", status: "degraded", streamName: null }).tone, "warn");
});

// T-1318 mục 5 — cờ basedOnDemo lưu khi trả lời; câu trả lời cũ (chưa có cờ) nhận diện qua cảnh báo demo.
test("answerBasedOnDemo dùng cờ đã lưu, fallback nhận diện cảnh báo dữ liệu mẫu", () => {
  assert.equal(answerBasedOnDemo({ basedOnDemo: true, warnings: [] }), true);
  assert.equal(answerBasedOnDemo({ basedOnDemo: false, warnings: [] }), false);
  assert.equal(answerBasedOnDemo({ warnings: ["249/249 bản ghi là dữ liệu mẫu (demo). Có thể xóa trong Cài đặt."] }), true);
  assert.equal(answerBasedOnDemo({ warnings: ["Khoảng thời gian chưa kết thúc — so sánh có thể chưa tương đương."] }), false);
  assert.equal(answerBasedOnDemo(null), false);
  assert.equal(answerBasedOnDemo(undefined), false);
});
