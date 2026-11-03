import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { routeQuestion, requiredTools, validatePlan, validateRoi, parseObject } from "../src/lib/ai/routing";
import { normalizeExtraction, mergeImageResults } from "../src/lib/ai/vision-worker";
import { serviceConfig } from "../src/lib/ai/services";
import { can, signToken, verifyToken } from "../src/lib/token";
import { randomBytes } from "node:crypto";

const sample = { summary: "Fixture hợp đồng, không phải nhận diện thực", details: [], objects: [{ label: "hộp", count: 7, confidence: 0.8, boxes: [[0.1, 0.2, 0.3, 0.4]] }], ocrText: "Mã A1", structured: [{ key: "Mã", value: "A1", confidence: 0.9 }, { key: "Không rõ", value: null, confidence: 0 }], confidence: 0.8, warnings: [] };

test("Routing: câu số liệu đi thẳng Gateway; báo cáo sâu qua điều phối", () => {
  for (const q of ["Hôm nay có bao nhiêu khách?", "Hôm qua có bao nhiêu xe máy vào bãi?", "Giờ cao điểm 7 ngày qua là khi nào?", "Tìm cảnh báo trong kho tuần này", "Khách đầu tiên lúc mấy giờ?"])
    assert.equal(routeQuestion(q).path, "fast", q);
  for (const q of ["Phân tích toàn bộ camera tuần trước, tìm bất thường và lập báo cáo", "Đối chiếu nhiều camera và giải thích nguyên nhân"])
    assert.equal(routeQuestion(q).path, "orchestrated", q);
});
test("Tool contracts: single specialist bypass; compound extraction uses 2 workers", () => {
  assert.deepEqual(requiredTools("extract", "Đếm hộp", "object_count"), ["vision.extract"]);
  assert.deepEqual(requiredTools("extract", "Đếm hộp, đọc mã trên nhãn và lập bảng", "freeform"), ["vision.extract", "ocr.extract"]);
  assert.deepEqual(requiredTools("extract", "Đọc chữ", "ocr"), ["ocr.extract"]);
});
test("Remote plan: reject SQL, URLs, shell tools and extra fields", () => {
  assert.deepEqual(validatePlan({ tools: ["memory.events", "memory.summary", "memory.summary"] }, "report").tools, ["memory.events", "memory.summary"]);
  for (const plan of [{ tools: ["terminal"] }, { tools: ["memory.summary"], sql: "DROP TABLE events" }, { tools: ["memory.summary"], url: "http://evil.test" }, { tools: [] }, { tools: ["vision.extract"] }])
    assert.throws(() => validatePlan(plan, "report"));
  assert.equal(parseObject('```json\n{"tools":["memory.summary"]}\n```').tools instanceof Array, true);
  assert.throws(() => parseObject("not json"));
});
test("ROI: finite, normalized and fully inside source image", () => {
  assert.deepEqual(validateRoi({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  assert.equal(validateRoi(null), null);
  for (const roi of [{ x: NaN, y: 0, w: 1, h: 1 }, { x: 0.9, y: 0, w: 0.5, h: 1 }, { x: 0, y: 0, w: 0, h: 1 }, { x: "0", y: 0, w: 1, h: 1 }]) assert.throws(() => validateRoi(roi));
});
test("Extraction: unknown is not zero; immutable AI result; no duplicate object sums", () => {
  const result = normalizeExtraction(sample, "fixture");
  assert.equal(result.objects[0].count, 7);
  assert.equal(result.structured.length, 1);
  assert.equal(result.engine[0], "fixture");
  assert.throws(() => normalizeExtraction({ ...sample, objects: [{ label: "hộp", count: null }] }, "fixture"));
  assert.throws(() => normalizeExtraction({ ...sample, objects: [{ label: "hộp", count: -1 }] }, "fixture"));
  const badBox = normalizeExtraction({ ...sample, objects: [{ label: "hộp", count: 7, boxes: [[0.9, 0, 0.3, 0.1]] }] }, "fixture");
  assert.equal(badBox.objects[0].boxes, undefined);
  assert.ok(badBox.warnings.includes("Đã bỏ 1 vùng chọn không hợp lệ do AI trả về."));
  assert.equal(mergeImageResults(result, { ...result, objects: [] }).objects[0].count, 7);
  assert.throws(() => mergeImageResults());
});
test("RBAC and expiring session tokens", async () => {
  assert.equal(can("viewer", "ask"), true); assert.equal(can("viewer", "capture"), false); assert.equal(can("operator", "delete"), false);
  const payload = { sid: "fixture", sub: 1, name: "Thử nghiệm", role: "viewer" as const, device: "test", exp: Math.floor(Date.now() / 1000) + 60 };
  const token = await signToken(payload);
  assert.equal((await verifyToken(token))?.name, payload.name);
  assert.equal(await verifyToken(token + "x"), null);
  assert.equal(await verifyToken(await signToken({ ...payload, exp: 1 })), null);
});
test("Deployment endpoints: server-only config, no credentials in URL, TLS outside LAN", () => {
  const keys = ["HERMES_BASE_URL", "HERMES_API_KEY", "HERMES_EGRESS"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    delete process.env.HERMES_BASE_URL; assert.equal(serviceConfig("hermes"), null);
    process.env.HERMES_API_KEY = randomBytes(32).toString("hex");
    process.env.HERMES_BASE_URL = "http://127.0.0.1:8642/p/camera/v1";
    // Egress do server khai báo: chưa khai báo ⇒ fail-safe remote (bridge loopback có thể ra Internet).
    delete process.env.HERMES_EGRESS;
    assert.equal(serviceConfig("hermes")?.remote, true);
    assert.equal(serviceConfig("hermes")?.egress, "remote");
    process.env.HERMES_EGRESS = "local";
    assert.equal(serviceConfig("hermes")?.remote, false);
    assert.equal(serviceConfig("hermes")?.egress, "local");
    assert.equal(serviceConfig("hermes")?.base.pathname, "/p/camera/v1/");
    process.env.HERMES_BASE_URL = "http://example.com/v1"; assert.throws(() => serviceConfig("hermes"));
    process.env.HERMES_BASE_URL = "https://example.com/v1"; assert.equal(serviceConfig("hermes")?.remote, true);
    process.env.HERMES_BASE_URL = "https://user:password@example.com/v1"; assert.throws(() => serviceConfig("hermes"));
  } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
