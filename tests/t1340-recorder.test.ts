import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  applyRecordPatch,
  disableRecording,
  ensureRecordingPath,
  recorderConfig,
  recorderState,
  removeRecordingPath,
} from "../src/lib/camera/recorder";

/**
 * T-1340 — control-plane recorder mediaMTX. fetch được mock nên test chạy không
 * cần mediaMTX/DB thật:
 *   (a) add 400 → patch fallback, body ghi đúng hợp đồng; gọi 2 lần không lỗi
 *   (b) disable → PATCH record:false; remove → DELETE path
 *   (c) mediaMTX 500 / mất mạng ⇒ reachable:false (không throw)
 *   (d) PATCH bật record khi recorder chết ⇒ 503 và persist() (ghi DB) không
 *       được gọi ⇒ record_enabled đứng yên
 */

// Ép base URL để assert được request URL chính xác dù env máy dev có set sẵn.
process.env.MEDIAMTX_API = "http://127.0.0.1:9997";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type MtxCall = { method: string; url: string; body: Record<string, unknown> | null };

/** Mock fetch + ghi lại mọi request (method, url, body JSON) để assert chuỗi gọi. */
function mockMtx(handler: (c: MtxCall) => Response | Promise<Response>): MtxCall[] {
  const calls: MtxCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const c: MtxCall = { method: init?.method ?? "GET", url: String(input), body: null };
    if (typeof init?.body === "string") {
      try {
        c.body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        /* body không phải JSON — bỏ qua */
      }
    }
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return calls;
}

const mockDead = () => {
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:9997");
  }) as typeof fetch;
};

const SRC = "rtsp://user:secret@192.168.1.9:554/cam";

/* ============ (a) ensureRecordingPath: add → 400 → patch fallback ============ */

test("ensureRecordingPath: add 400 → patch fallback, body đúng hợp đồng, idempotent", async () => {
  const calls = mockMtx((c) => {
    if (c.url.includes("/v3/config/paths/add/")) return new Response("path already exists", { status: 400 });
    if (c.url.includes("/v3/config/paths/patch/")) return new Response("{}", { status: 200 });
    if (c.url.includes("/v3/paths/get/")) return Response.json({ name: "dai_cam_9", record: true, ready: true });
    return new Response("unexpected", { status: 500 });
  });

  const st = await ensureRecordingPath({ streamName: "dai_cam_9", sourceUrl: SRC, retentionDays: 14 });
  assert.deepEqual(st, { reachable: true, pathExists: true, recording: true });

  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "http://127.0.0.1:9997/v3/config/paths/add/dai_cam_9");
  const sent = calls[0].body!;
  assert.equal(sent.source, SRC); // mediaMTX cần source thật — nhưng state/lỗi trả về không được chứa nó
  assert.equal(sent.sourceProtocol, "tcp");
  assert.equal(sent.sourceOnDemand, false);
  assert.equal(sent.record, true);
  assert.equal(sent.recordFormat, "fmp4");
  assert.equal(sent.recordSegmentDuration, "5m");
  assert.equal(sent.recordPartDuration, "1s");
  assert.equal(sent.recordDeleteAfter, "14d");
  assert.match(String(sent.recordPath), /%path\/%Y-%m-%d_%H-%M-%S-%f$/);

  assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[1].url, "http://127.0.0.1:9997/v3/config/paths/patch/dai_cam_9");
  assert.equal(calls[2].method, "GET"); // confirm bằng /v3/paths/get
  assert.ok(!JSON.stringify(st).includes("secret"), "state trả về không được rò credential");

  // Idempotent: gọi lần 2 cùng flow add-400→patch, vẫn thành công.
  calls.length = 0;
  const st2 = await ensureRecordingPath({ streamName: "dai_cam_9", sourceUrl: SRC, retentionDays: 14 });
  assert.equal(st2.recording, true);
  assert.equal(calls.length, 3);
});

test("ensureRecordingPath: add 200 trực tiếp (path mới) → confirm get, không cần patch", async () => {
  const calls = mockMtx((c) => {
    if (c.url.includes("/v3/config/paths/add/")) return new Response("{}", { status: 200 });
    if (c.url.includes("/v3/paths/get/")) return Response.json({ name: "dai_cam_9", record: true });
    return new Response("unexpected", { status: 500 });
  });
  const st = await ensureRecordingPath({ streamName: "dai_cam_9", sourceUrl: SRC });
  assert.equal(st.recording, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body!.recordDeleteAfter, "7d", "không truyền retentionDays ⇒ fallback keep");
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].body, null, "confirm GET không có body");
});

test("ensureRecordingPath: source rỗng → từ chối, tuyệt đối không gọi mediaMTX", async () => {
  const calls = mockMtx(() => new Response("{}", { status: 200 }));
  const st = await ensureRecordingPath({ streamName: "dai_cam_9", sourceUrl: "  " });
  assert.equal(st.recording, false);
  assert.equal(calls.length, 0, "không được gọi API khi source rỗng");
});

/* ============ (b) disable / remove ============ */

test("disableRecording: PATCH record:false", async () => {
  const calls = mockMtx((c) => {
    assert.match(c.url, /\/v3\/config\/paths\/patch\/dai_cam_9$/);
    return new Response("{}", { status: 200 });
  });
  const st = await disableRecording("dai_cam_9");
  assert.deepEqual(st, { reachable: true, pathExists: true, recording: false });
  assert.deepEqual(calls[0].body, { record: false });
  assert.equal(calls[0].method, "PATCH");
});

test("removeRecordingPath: DELETE; 404 coi như đã gỡ", async () => {
  const calls = mockMtx((c) => {
    assert.match(c.url, /\/v3\/config\/paths\/delete\/dai_cam_9$/);
    return new Response("not found", { status: 404 });
  });
  const st = await removeRecordingPath("dai_cam_9");
  assert.deepEqual(st, { reachable: true, pathExists: false, recording: false });
  assert.equal(calls[0].method, "DELETE");
});

/* ============ (c) trạng thái / lỗi ============ */

test("recorderState: 404 → reachable:true pathExists:false; 500 → reachable:false", async () => {
  mockMtx(() => new Response("not found", { status: 404 }));
  assert.deepEqual(await recorderState("dai_cam_9"), { reachable: true, pathExists: false, recording: false });

  mockMtx(() => new Response("boom", { status: 500 }));
  const st = await recorderState("dai_cam_9");
  assert.equal(st.reachable, false);
  assert.equal(st.recording, false);
});

test("mất mạng → reachable:false, KHÔNG throw", async () => {
  mockDead();
  const st = await recorderState("dai_cam_9");
  assert.equal(st.reachable, false);
  assert.ok(st.error);
  assert.equal((await ensureRecordingPath({ streamName: "dai_cam_9", sourceUrl: SRC })).reachable, false);
  assert.equal((await disableRecording("dai_cam_9")).reachable, false);
  assert.equal((await removeRecordingPath("dai_cam_9")).reachable, false);
});

test("streamName lạ → từ chối trước khi gọi API (chống traversal)", async () => {
  const calls = mockMtx(() => new Response("{}", { status: 200 }));
  assert.equal((await recorderState("../etc")).reachable, false);
  assert.equal((await removeRecordingPath("a/b")).reachable, false);
  assert.equal(calls.length, 0);
});

test("recorderConfig: mặc định theo card", () => {
  const c = recorderConfig();
  assert.equal(c.api, "http://127.0.0.1:9997");
  assert.equal(c.segment, "5m");
  assert.equal(c.keep, "7d");
  assert.ok(c.recordingsDir.length > 0);
});

/* ============ (d) applyRecordPatch — seam của PATCH /settings ============ */

test("bật record khi recorder chết ⇒ 503 'Không bật được ghi hình', persist() không chạy", async () => {
  mockDead();
  let persisted = false;
  const out = await applyRecordPatch({
    enable: true,
    current: false,
    streamName: "dai_cam_9",
    sourceUrl: SRC,
    retentionDays: 7,
    persist: async () => {
      persisted = true;
      return { ok: true };
    },
  });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.status, 503);
    assert.equal(out.title, "Không bật được ghi hình");
  }
  assert.equal(persisted, false, "recorder chết thì tuyệt đối không ghi DB — record_enabled đứng yên");
});

test("bật record không có nguồn RTSP ⇒ 400, persist() không chạy", async () => {
  const calls = mockMtx(() => new Response("{}", { status: 200 }));
  let persisted = false;
  const out = await applyRecordPatch({
    enable: true,
    current: false,
    streamName: "dai_cam_9",
    sourceUrl: null,
    retentionDays: 7,
    persist: async () => {
      persisted = true;
      return { ok: true };
    },
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.status, 400);
  assert.equal(persisted, false);
  assert.equal(calls.length, 0);
});

test("bật record thành công ⇒ persist chạy sau khi ensure", async () => {
  const events: string[] = [];
  mockMtx((c) => {
    events.push("mtx");
    if (c.url.includes("/v3/config/paths/add/")) return new Response("{}", { status: 200 });
    return Response.json({ name: "dai_cam_9", record: true });
  });
  const out = await applyRecordPatch({
    enable: true,
    current: false,
    streamName: "dai_cam_9",
    sourceUrl: SRC,
    retentionDays: 7,
    persist: async () => {
      events.push("db");
      return { ok: true };
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(events, ["mtx", "mtx", "db"], "ensure xong (add + confirm get) mới được ghi DB");
});

test("tắt record: persist commit ⇒ PATCH record:false; persist 409 ⇒ không đụng recorder", async () => {
  const events: string[] = [];
  mockMtx(() => {
    events.push("mtx");
    return new Response("{}", { status: 200 });
  });
  const out = await applyRecordPatch({
    enable: false,
    current: true,
    streamName: "dai_cam_9",
    sourceUrl: SRC,
    retentionDays: 7,
    persist: async () => {
      events.push("db");
      return { ok: true };
    },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(events, ["db", "mtx"], "ghi DB trước, recorder theo sau");

  events.length = 0;
  const conflict = await applyRecordPatch({
    enable: false,
    current: true,
    streamName: "dai_cam_9",
    sourceUrl: SRC,
    retentionDays: 7,
    persist: async () => {
      events.push("db");
      return { ok: false };
    },
  });
  assert.equal(conflict.ok, true);
  assert.deepEqual(events, ["db"], "persist không commit ⇒ không gọi disableRecording");
});
