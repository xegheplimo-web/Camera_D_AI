// keepwarm-core: pure timer/consumer-map logic — no DB, no Next, no real timers.
// Run: node --test tests/keepwarm.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeepWarm, keepWarmEnabled, KEEPWARM_ENV } from "../src/lib/camera/keepwarm-core.ts";

const flush = () => new Promise((r) => setImmediate(r));

function makeIo(overrides = {}) {
  const timers = { next: 1, created: [], cleared: [] };
  const consumers = [];
  const io = {
    isEnabled: () => true,
    listStreams: async () => new Map([[1, "cam_a"]]),
    runConsumer: (name, signal) => {
      const c = { name, aborted: false };
      signal.addEventListener("abort", () => {
        c.aborted = true;
      });
      consumers.push(c);
      return new Promise(() => {});
    },
    setInterval: (fn, ms) => {
      const id = timers.next++;
      timers.created.push({ id, fn, ms });
      return id;
    },
    clearInterval: (h) => {
      timers.cleared.push(h);
    },
    scanMs: 1000,
    ...overrides,
  };
  return { io, timers, consumers };
}

test("keepWarmEnabled: default on, GO2RTC_KEEPWARM=0 off", () => {
  assert.equal(keepWarmEnabled({}), true);
  assert.equal(keepWarmEnabled({ [KEEPWARM_ENV]: "0" }), false);
  assert.equal(keepWarmEnabled({ [KEEPWARM_ENV]: "1" }), true);
});

test("env 0 -> start() creates no timer and no consumer", async () => {
  process.env[KEEPWARM_ENV] = "0";
  try {
    const { io, timers, consumers } = makeIo({ isEnabled: () => keepWarmEnabled() });
    const kw = createKeepWarm(io);
    kw.start();
    await flush();
    assert.equal(timers.created.length, 0);
    assert.equal(consumers.length, 0);
    assert.equal(kw.activeCount(), 0);
  } finally {
    delete process.env[KEEPWARM_ENV];
  }
});

test("start twice -> exactly one timer", async () => {
  const { io, timers } = makeIo();
  const kw = createKeepWarm(io);
  kw.start();
  kw.start();
  await flush();
  assert.equal(timers.created.length, 1);
  assert.equal(timers.created[0].ms, 1000);
  kw.stop();
});

test("stop clears the timer and aborts every consumer", async () => {
  const { io, timers, consumers } = makeIo();
  const kw = createKeepWarm(io);
  kw.start();
  await flush();
  assert.equal(consumers.length, 1);
  kw.stop();
  assert.deepEqual(timers.cleared, [timers.created[0].id]);
  assert.equal(consumers[0].aborted, true);
  assert.equal(kw.activeCount(), 0);
});

test("listStreams failure (no DB) -> tick does not throw, no consumer", async () => {
  const { io } = makeIo({
    listStreams: async () => {
      throw new Error("DB down");
    },
  });
  const kw = createKeepWarm(io);
  await assert.doesNotReject(kw.tick());
  assert.equal(kw.activeCount(), 0);
});

test("camera removed from list -> its consumer is aborted", async () => {
  let list = new Map([[1, "cam_a"]]);
  const { io, consumers } = makeIo({ listStreams: async () => list });
  const kw = createKeepWarm(io);
  kw.start();
  await flush();
  assert.equal(consumers.length, 1);
  list = new Map();
  await kw.tick();
  await flush();
  assert.equal(consumers[0].aborted, true);
  assert.equal(kw.activeCount(), 0);
  kw.stop();
});

test("interval callback drives tick -> new camera gets a consumer", async () => {
  let list = new Map();
  const { io, timers, consumers } = makeIo({ listStreams: async () => list });
  const kw = createKeepWarm(io);
  kw.start();
  await flush();
  assert.equal(consumers.length, 0);
  list = new Map([[7, "cam_b"]]);
  timers.created[0].fn();
  await flush();
  assert.equal(consumers.length, 1);
  assert.equal(consumers[0].name, "cam_b");
  kw.stop();
});
