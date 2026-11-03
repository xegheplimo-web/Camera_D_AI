import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { probeRtsp, effectiveStatus, sourceKind, clearProbeCache } from "../src/lib/camera/health";
import { encryptSource } from "../src/lib/camera/stream";
import { listStatus, streamBadge } from "../src/lib/camera/status";

// T-1319 — trạng thái kết nối phải đến từ probe thật (mediaMTX cho RTSP,
// client state cho webcam), không từ cột status trong DB.

process.env.CAMERA_CREDENTIAL_KEY ??= "ab".repeat(32);

const realFetch = globalThis.fetch;
let fetchCalls = 0;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearProbeCache();
  fetchCalls = 0;
});

function mockPaths(items: unknown) {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as typeof fetch;
}

function mockFetchError() {
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("connect ECONNREFUSED 127.0.0.1:9997");
  }) as typeof fetch;
}

function mockFetchHang() {
  globalThis.fetch = ((_: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (init?.signal?.aborted) return onAbort();
    init?.signal?.addEventListener("abort", onAbort);
  })) as typeof fetch;
}

test("probeRtsp: path ready+online → online; thiếu/không ready/không online → offline", async () => {
  mockPaths([{ name: "cam", ready: true, online: true }]);
  assert.equal(await probeRtsp("cam"), "online");

  clearProbeCache();
  mockPaths([{ name: "cam", ready: true, online: false }]);
  assert.equal(await probeRtsp("cam"), "offline");

  clearProbeCache();
  mockPaths([{ name: "cam", ready: false, online: true }]);
  assert.equal(await probeRtsp("cam"), "offline");

  clearProbeCache();
  mockPaths([{ name: "cam", ready: true, online: true }]);
  assert.equal(await probeRtsp("khac"), "offline");
});

test("probeRtsp: lỗi mạng hoặc timeout → unknown; HTTP không 200 → unknown", async () => {
  mockFetchError();
  assert.equal(await probeRtsp("cam"), "unknown");

  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("bad", { status: 500 });
  }) as typeof fetch;
  clearProbeCache();
  assert.equal(await probeRtsp("cam"), "unknown");

  mockFetchHang();
  clearProbeCache();
  assert.equal(await probeRtsp("cam", 50), "unknown"); // timeout 50 ms, timer được clearTimeout trong finally
});

test("probeRtsp cache 5 giây: chỉ gọi mediaMTX một lần cho cùng streamName", async () => {
  mockPaths([{ name: "cam", ready: true, online: true }]);
  assert.equal(await probeRtsp("cam"), "online");
  assert.equal(await probeRtsp("cam"), "online");
  assert.equal(fetchCalls, 1, "cache phải chặn gọi API lặp lại trong 5 giây");

  // streamName khác → entry cache khác → fetch mới
  assert.equal(await probeRtsp("khac"), "offline");
  assert.equal(fetchCalls, 2);
});

test("effectiveStatus: webcam → client, demo → simulated, không cần gọi mediaMTX", async () => {
  mockPaths([]);
  assert.equal(await effectiveStatus({ sourceType: "webcam", streamName: null }), "client");
  assert.equal(await effectiveStatus({ sourceType: "demo", streamName: null }), "simulated");
  assert.equal(fetchCalls, 0, "webcam/demo không được phép probe mediaMTX");
});

test("effectiveStatus: chỉ probe đúng streamName — không đoán basename (tránh online giả)", async () => {
  mockPaths([{ name: "cam", ready: true, online: true }]);
  assert.equal(await effectiveStatus({ sourceType: "rtsp", streamName: "cam" }), "online");

  // Camera khác dùng chung nguồn .../cam nhưng streamName=dai_cam_7: path "cam" KHÔNG phải của nó.
  const cam = { sourceType: "rtsp", streamName: "dai_cam_7" };
  assert.equal(await effectiveStatus(cam), "offline", "không được khớp path của camera khác");

  clearProbeCache();
  mockPaths([{ name: "dai_cam_7", ready: true, online: true }]);
  assert.equal(await effectiveStatus(cam), "online", "path đúng tên camera thì online");

  clearProbeCache();
  mockPaths([{ name: "dai_cam_7", ready: false, online: false }]);
  assert.equal(await effectiveStatus(cam), "offline", "path tồn tại nhưng publisher chết → offline");

  clearProbeCache();
  mockFetchError();
  assert.equal(await effectiveStatus(cam), "unknown", "không gọi được nguồn nào → unknown");

  clearProbeCache();
  mockPaths([]);
  assert.equal(await effectiveStatus({ sourceType: "rtsp", streamName: null }), "offline");
});

test("effectiveStatus: go2rtc (đường detector) sống thì online dù mediaMTX chưa có path", async () => {
  process.env.GO2RTC_API = "http://127.0.0.1:1984";
  try {
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/frame.jpeg")) return new Response("jpeg", { status: 200 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    assert.equal(await effectiveStatus({ sourceType: "rtsp", streamName: "dai_cam_34" }), "online");

    clearProbeCache();
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/frame.jpeg")) return new Response("no", { status: 404 });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    assert.equal(await effectiveStatus({ sourceType: "rtsp", streamName: "dai_cam_34" }), "offline");
  } finally {
    delete process.env.GO2RTC_API;
  }
});

test("sourceKind: rtsp → physical, webcam → webcam, demo → simulated", () => {
  assert.equal(sourceKind("rtsp"), "physical");
  assert.equal(sourceKind("webcam"), "webcam");
  assert.equal(sourceKind("demo"), "simulated");
});

test("listStatus không trả 'Trực tiếp' cho webcam/demo/rtsp-offline/rtsp-unknown", () => {
  assert.equal(listStatus({ sourceType: "rtsp", status: "degraded", streamName: "dai_cam_1" }, "online").label, "Trực tiếp");
  assert.equal(listStatus({ sourceType: "rtsp", status: "degraded", streamName: "dai_cam_1" }, "online").tone, "ok");
  assert.equal(listStatus({ sourceType: "rtsp", status: "degraded", streamName: "dai_cam_1" }, "offline").label, "Mất kết nối");
  assert.equal(listStatus({ sourceType: "rtsp", status: "degraded", streamName: "dai_cam_1" }, "offline").tone, "warn");
  assert.notEqual(listStatus({ sourceType: "rtsp", status: "degraded", streamName: "dai_cam_1" }, "unknown").label, "Trực tiếp");

  // webcam/demo: connection truyền vào cũng không được đổi nhãn sang Trực tiếp
  assert.equal(listStatus({ sourceType: "webcam", status: "offline" }, "online").label, "Trên trình duyệt");
  assert.equal(listStatus({ sourceType: "demo", status: "demo" }, "online").label, "Mô phỏng");

  // fallback cũ khi chưa có dữ liệu health
  assert.equal(listStatus({ sourceType: "rtsp", status: "degraded", streamName: "dai_cam_1" }).label, "Đã đăng ký");
  assert.equal(listStatus({ sourceType: "rtsp", status: "degraded", streamName: null }).tone, "warn");
});

test("streamBadge: rtsp chỉ 'Trực tiếp' khi connection=online", () => {
  assert.equal(streamBadge("rtsp", "live", "online"), "Trực tiếp");
  assert.equal(streamBadge("rtsp", "live", "offline"), "Mất kết nối");
  assert.notEqual(streamBadge("rtsp", "live", "unknown"), "Trực tiếp");
  // nhãn webcam/demo vẫn theo nguồn, không phải connection
  assert.equal(streamBadge("webcam", "live", "online"), "Webcam trên trình duyệt · Đang bật");
  assert.equal(streamBadge("demo", "live", "online"), "Nguồn mô phỏng");
});
