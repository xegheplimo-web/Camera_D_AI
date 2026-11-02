import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExtraction } from "../src/lib/ai/vision-worker";

// T-1316 — boxes chỉ phục vụ overlay: box lỗi bị bỏ riêng từng cái kèm cảnh báo,
// không được làm mất toàn bộ summary/details/ocrText/structured của lần gọi AI.
const base = { summary: "Tóm tắt mẫu", details: [], objects: [], ocrText: "", structured: [], confidence: 0.8, warnings: [] };
const withObject = (o: Record<string, unknown>) => ({ ...base, objects: [o] });
const boxWarnings = (warnings: string[]) => warnings.filter((w) => w.includes("vùng chọn không hợp lệ"));

test("Vision boxes: box hợp lệ giữ nguyên, không cảnh báo", () => {
  const r = normalizeExtraction(withObject({ label: "hộp", count: 1, confidence: 0.9, boxes: [[0.1, 0.2, 0.3, 0.4]] }), "fixture");
  assert.deepEqual(r.objects[0].boxes, [[0.1, 0.2, 0.3, 0.4]]);
  assert.equal(boxWarnings(r.warnings).length, 0);
});

test("Vision boxes: box ngoài [0,1] bị bỏ, box còn lại giữ, cảnh báo đếm đúng", () => {
  const r = normalizeExtraction(withObject({ label: "hộp", count: 1, boxes: [[1.2, 0, 0.5, 0.5], [0.1, 0.1, 0.2, 0.2]] }), "fixture");
  assert.deepEqual(r.objects[0].boxes, [[0.1, 0.1, 0.2, 0.2]]);
  assert.ok(r.warnings.includes("Đã bỏ 1 vùng chọn không hợp lệ do AI trả về."));
});

test("Vision boxes: box vượt biên bị bỏ; hết box hợp lệ thì bỏ hẳn trường boxes", () => {
  const r = normalizeExtraction(withObject({ label: "xe", count: 2, boxes: [[0.9, 0.9, 0.5, 0.5]] }), "fixture");
  assert.equal(r.objects[0].label, "xe");
  assert.equal("boxes" in r.objects[0], false);
  assert.ok(r.warnings.includes("Đã bỏ 1 vùng chọn không hợp lệ do AI trả về."));
});

test("Vision boxes: box sai kiểu/sai độ dài bị bỏ, không throw", () => {
  const r = normalizeExtraction(withObject({ label: "hộp", count: 1, boxes: [["a", 0, 1, 1], [0.1, 0.2, 0.3], [0, 0, 0, 0], [NaN, 0, 0.1, 0.1], "box"] }), "fixture");
  assert.equal("boxes" in r.objects[0], false);
  assert.ok(r.warnings.includes("Đã bỏ 5 vùng chọn không hợp lệ do AI trả về."));
});

test("Vision boxes: nhiều object gộp một cảnh báo đếm tổng số box bị bỏ", () => {
  const r = normalizeExtraction({ ...base, objects: [
    { label: "a", count: 1, boxes: [[2, 0, 1, 1]] },
    { label: "b", count: 1, boxes: [[0.1, 0.1, 0.2, 0.2], [-0.1, 0, 0.5, 0.5]] },
  ] }, "fixture");
  assert.deepEqual(r.objects[1].boxes, [[0.1, 0.1, 0.2, 0.2]]);
  assert.deepEqual(boxWarnings(r.warnings), ["Đã bỏ 2 vùng chọn không hợp lệ do AI trả về."]);
});

test("Vision boxes: object không có trường boxes thì không cảnh báo, không thêm trường", () => {
  const r = normalizeExtraction(withObject({ label: "hộp", count: 3 }), "fixture");
  assert.equal("boxes" in r.objects[0], false);
  assert.equal(boxWarnings(r.warnings).length, 0);
});

test("Vision boxes: trường bắt buộc vẫn fail-closed", () => {
  assert.throws(() => normalizeExtraction({ ...base, summary: 42 }, "fixture"), { code: "INVALID_EXTRACTION" });
  assert.throws(() => normalizeExtraction({ details: [], objects: [], ocrText: "", structured: [] }, "fixture"), { code: "INVALID_EXTRACTION" });
  assert.throws(() => normalizeExtraction(withObject({ label: "hộp", count: -1 }), "fixture"), { code: "INVALID_EXTRACTION" });
});
