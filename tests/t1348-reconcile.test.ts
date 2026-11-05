/**
 * T-1348 — reconcile path ghi hình sau khi mediaMTX restart.
 *
 * mediaMTX thật bị thay bằng `fetch` giả (state trong RAM) để test tất định và
 * không phá bản ghi đang chạy; phần DB dùng Postgres thật vì reconcile đọc
 * camera_settings thật. Test tự dọn hàng đã tạo.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { cameraSettings, cameras } from "../src/db/schema";
import { encryptSource } from "../src/lib/camera/stream";
import { reconcileRecordingPaths } from "../src/lib/camera/reconcile";
import { ensureDefaultTenant } from "./helpers/tenant";

// Khoá mã hoá nguồn RTSP cho fixture (64 hex). Shell có thể đã export khoá sai
// độ dài ⇒ chỉ thay khi giá trị hiện tại không hợp lệ, không ghi đè khoá thật của CI.
if (!/^[0-9a-fA-F]{64}$/.test(process.env.CAMERA_CREDENTIAL_KEY ?? "")) {
  // Khoá toàn số 0: hợp lệ về định dạng, entropy 0 nên không bị gitleaks coi là secret.
  process.env.CAMERA_CREDENTIAL_KEY = "0".repeat(64);
}

type PathCfg = { record: boolean; source?: string };

const realFetch = globalThis.fetch;
let paths = new Map<string, PathCfg>();
let calls: string[] = [];

function fakeMediaMtx() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = url.match(/\/v3\/(?:config\/)?paths\/(get|add|patch)\/([^/?]+)/);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
    if (url.includes("/v3/paths/get/")) return new Response("{}", { status: 200 }); // runtime: không có record
    if (!m) return new Response("{}", { status: 404 });
    const [, op, raw] = m;
    const name = decodeURIComponent(raw);
    if (op === "get") {
      const cfg = paths.get(name);
      if (!cfg) return new Response("not found", { status: 404 });
      return Response.json({ name, record: cfg.record, source: cfg.source });
    }
    if (op === "add") {
      if (paths.has(name)) return new Response("already exists", { status: 400 });
      paths.set(name, { record: true, source: JSON.parse(String(init?.body)).source });
      return new Response("{}", { status: 200 });
    }
    const cfg = paths.get(name);
    if (!cfg) return new Response("not found", { status: 404 });
    paths.set(name, { ...cfg, record: true, source: JSON.parse(String(init?.body)).source });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

async function makeCamera(streamName: string, recordEnabled: boolean) {
  await ensureDefaultTenant();
  const [cam] = await db
    .insert(cameras)
    .values({
      code: `T1348${Date.now() % 100000}${Math.floor(Math.random() * 100)}`,
      name: `T1348 ${streamName}`,
      location: "test",
      sourceType: "rtsp",
      streamName,
      sourceCiphertext: encryptSource("rtsp://192.168.1.50:554/h264/ch1/main/av_stream"),
    })
    .returning({ id: cameras.id });
  await db.insert(cameraSettings).values({ tenantId: 1, cameraId: cam.id, recordEnabled });
  return cam.id;
}

async function cleanup(cameraId: number) {
  await db.delete(cameraSettings).where(eq(cameraSettings.cameraId, cameraId));
  await db.delete(cameras).where(eq(cameras.id, cameraId));
}

afterEach(() => {
  globalThis.fetch = realFetch;
  paths = new Map();
  calls = [];
});

test("path đã ghi đúng ⇒ bỏ qua, không gọi add/patch", async () => {
  const id = await makeCamera("dai_cam_t1348_a", true);
  paths.set("dai_cam_t1348_a", { record: true, source: "rtsp://x" });
  fakeMediaMtx();
  try {
    const r = await reconcileRecordingPaths();
    assert.ok(r.checked >= 1);
    assert.ok(r.skipped >= 1, "phải skip camera đã ghi đúng");
    // DB dev dùng chung có camera khác đang bật ghi — chỉ khẳng định trên stream
    // của test: camera đã ghi đúng thì không được phát sinh write nào cho nó.
    assert.equal(
      calls.filter((c) => /POST|PATCH/.test(c) && c.includes("dai_cam_t1348_a")).length,
      0,
      "không được gọi write cho camera đã ghi đúng",
    );
  } finally {
    await cleanup(id);
  }
});

test("path biến mất sau restart ⇒ tự tạo lại", async () => {
  const id = await makeCamera("dai_cam_t1348_b", true);
  fakeMediaMtx(); // paths rỗng = mediaMTX vừa restart
  try {
    const r = await reconcileRecordingPaths();
    assert.ok(r.ensured >= 1, "phải bật lại được path");
    assert.equal(paths.get("dai_cam_t1348_b")?.record, true);
    assert.ok(calls.some((c) => c.startsWith("POST /v3/config/paths/add/dai_cam_t1348_b")));
  } finally {
    await cleanup(id);
  }
});

test("camera tắt ghi hình ⇒ không đụng mediaMTX", async () => {
  const id = await makeCamera("dai_cam_t1348_c", false);
  fakeMediaMtx();
  try {
    await reconcileRecordingPaths();
    // DB dùng chung: camera khác có thể ensured/probe — chỉ khẳng định camera
    // tắt ghi của test không bị đụng tới (where recordEnabled=true loại nó ra).
    assert.equal(calls.filter((c) => c.includes("dai_cam_t1348_c")).length, 0, "không được probe camera tắt ghi");
    assert.equal(paths.has("dai_cam_t1348_c"), false);
  } finally {
    await cleanup(id);
  }
});

test("mediaMTX chết ⇒ ghi failed, không throw", async () => {
  const id = await makeCamera("dai_cam_t1348_d", true);
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  try {
    const r = await reconcileRecordingPaths();
    assert.equal(r.ensured, 0);
    assert.ok(r.failed.some((f) => f.cameraId === id), "phải báo failed cho camera này");
  } finally {
    await cleanup(id);
  }
});
