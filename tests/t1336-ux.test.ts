import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import { chromium, expect, type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import { ensureDefaultTenant } from "./helpers/tenant";
import { db, pool } from "../src/db";
import { users, cameras, assets, events, sessions, auditLog, knowledgeItems } from "../src/db/schema";
import { inArray, like, or } from "drizzle-orm";

/**
 * T-1336 — UI cài đặt theo camera: nút ⚙ trên khung hình + thẻ danh sách, drawer 5 mục
 * tại chỗ (không rời live, không reload stream), PATCH kèm revision + xử lý 409,
 * ghi chú từng ảnh, mobile 390px, không chuỗi nội bộ trong UI.
 * Fixture: owner + 2 camera demo + 2 asset thật (JPEG) gắn sự kiện, dọn sạch trong after().
 * Server: `next start` thật + Chromium thật (như browser-smoke).
 */
const prefix = `t1336_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let app: ChildProcess, base: string;
let browser: Browser, context: BrowserContext, page: Page;
let ownerId = 0, camA = 0, camB = 0, a1 = 0, a2 = 0;
const itemIds: number[] = [];
let cookie = "";
let logs = "";
const pageErrors: string[] = [];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const s = createServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); const n = (s.address() as { port: number }).port; await new Promise<void>((r) => s.close(() => r())); return n; }
async function call(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}
const dlg = () => page.locator('[role="dialog"][aria-label="Cài đặt camera"]');
const aiSection = () => dlg().locator('section[aria-label="Tính năng AI"]');

/** Mở drawer của `camId` qua nút ⚙ trên thẻ danh sách; chờ GET settings về 200. */
async function openDrawer(camId: number) {
  if (!(await dlg().isVisible().catch(() => false))) {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/cameras/${camId}/settings`) && r.request().method() === "GET"),
      page.locator(`[data-settings-card="${camId}"]`).click(),
    ]);
    assert.equal(res.status(), 200, "GET settings phải thành công khi mở drawer");
  }
  await dlg().waitFor({ state: "visible" });
  // Response settings về trước khi React commit (load() đợi Promise.all 4 request):
  // select "Hồ sơ" chỉ enable khi `s` đã set — đây là dấu hiệu render đã xong,
  // không thì assert ngay sau openDrawer đọc được trạng thái "Đang tải".
  await expect(dlg().locator('select[aria-label="Hồ sơ"]')).toBeEnabled();
}

/** Đóng drawer nếu đang mở — unmount ⇒ lần mở sau chạy load() và GET settings mới. */
async function closeDrawer() {
  if (!(await dlg().isVisible().catch(() => false))) return;
  await dlg().locator('button[aria-label="Đóng cài đặt"]').click();
  await dlg().waitFor({ state: "hidden" });
}

/**
 * Chặn GET /settings của camId: forward tới server thật rồi fulfill lại với
 * `capabilities` (và `extra` nếu cần) giả lập. T-1340 làm capabilities phụ thuộc
 * mediaMTX/segments thật ⇒ ca render phải tự mang contract, không theo máy chạy.
 */
async function stubCapabilities(camId: number, capabilities: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const url = `**/api/cameras/${camId}/settings`;
  const handler = async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, ...extra, capabilities } });
  };
  await page.route(url, handler);
  return () => page.unroute(url, handler);
}

/**
 * P1: danh mục mục trong drawer do cờ tính năng per-camera quyết định. Ca render
 * nào cần đủ mục thì phải khai báo cờ tường minh — camera mới chỉ bật `watch`
 * + `record`, nên mục "Ảnh & ghi chú" sẽ không có nếu không bật `product`.
 */
const FLAGS_ON = {
  watch: true, record: true, motion: true, intrusion: false, product: true,
  stock: false, delivery: false, people: false, vehicle: false,
};

before(async () => {
  // Fixture cần production build cho `next start` — build một lần nếu chưa có.
  if (!existsSync(".next/BUILD_ID")) {
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit" });
    assert.equal(r.status, 0, "next build thất bại (fixture cần `next start`)");
  }

  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  await ensureDefaultTenant();
  const [owner] = await db.insert(users).values({ login: `${prefix}_owner`, displayName: `${prefix}_owner`, role: "owner", passwordHash }).returning();
  ownerId = owner.id;

  const [ca] = await db.insert(cameras).values({ code: `${prefix}-a`, name: `${prefix} cam A`, location: "Fixture A", sourceType: "demo", status: "demo" }).returning();
  const [cb] = await db.insert(cameras).values({ code: `${prefix}-b`, name: `${prefix} cam B`, location: "Fixture B", sourceType: "demo", status: "demo" }).returning();
  camA = ca.id; camB = cb.id;

  const jpg = await sharp({ create: { width: 96, height: 54, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg().toBuffer();
  const [ra1, ra2] = await db.insert(assets).values([
    { kind: "image", mime: "image/jpeg", sha256: createHash("sha256").update(jpg).digest("hex"), data: jpg.toString("base64"), width: 96, height: 54, sizeBytes: jpg.length, origin: "capture", cameraId: camA, userId: ownerId },
    { kind: "image", mime: "image/jpeg", sha256: createHash("sha256").update(jpg).update("2").digest("hex"), data: jpg.toString("base64"), width: 96, height: 54, sizeBytes: jpg.length, origin: "capture", cameraId: camA, userId: ownerId },
  ]).returning();
  a1 = ra1.id; a2 = ra2.id;
  await db.insert(events).values([
    { cameraId: camA, type: "snapshot", label: `${prefix} snap 1`, assetId: a1, source: "manual" },
    { cameraId: camA, type: "snapshot", label: `${prefix} snap 2`, assetId: a2, source: "manual" },
  ]);

  const appPort = await freePort(); base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], { env: { ...process.env, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  app.stderr?.on("data", (s) => { logs = (logs + s).slice(-10000); });
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs);

  const login = await call("/api/auth/login", "POST", { login: `${prefix}_owner`, password });
  assert.equal(login.status, 200, JSON.stringify(login.data));

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(base + "/login");
  await page.getByRole("textbox", { name: "Tên đăng nhập", exact: true }).fill(`${prefix}_owner`);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await page.waitForURL(base + "/", { timeout: 25000 });
  await page.goto(base + "/camera");
  // Cookie riêng cho các call API kiểm chứng (đọc từ browser context).
  const cookies = await context.cookies(base);
  cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}, { timeout: 300000 });

after(async () => {
  if (app && app.exitCode === null) { app.kill("SIGTERM"); await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]); if (app.exitCode === null) app.kill("SIGKILL"); }
  await context?.close(); await browser?.close();
  await db.delete(knowledgeItems).where(or(inArray(knowledgeItems.id, itemIds.length ? itemIds : [-1]), like(knowledgeItems.title, `${prefix}%`), inArray(knowledgeItems.cameraId, [camA || -1, camB || -1])));
  const camIds = [camA, camB].filter(Boolean);
  if (camIds.length) {
    await db.delete(events).where(inArray(events.cameraId, camIds));
    await db.delete(cameras).where(inArray(cameras.id, camIds)); // camera_settings cascade
  }
  const assetIds = [a1, a2].filter(Boolean);
  if (assetIds.length) await db.delete(assets).where(inArray(assets.id, assetIds));
  if (ownerId) {
    await db.delete(sessions).where(inArray(sessions.userId, [ownerId]));
    await db.delete(users).where(inArray(users.id, [ownerId]));
  }
  await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
  await pool.end();
}, { timeout: 20000 });

/* ============ 1. Nút ⚙ trên mọi camera + trên khung hình ============ */

test("mỗi camera có nút ⚙ trên thẻ danh sách; khung hình đang xem cũng có ⚙", async () => {
  const dash = await call("/api/dashboard");
  assert.equal(dash.status, 200);
  const camIds = (dash.data.cameras as { id: number }[]).map((c) => c.id).sort((x, y) => x - y);
  assert.ok(camIds.includes(camA) && camIds.includes(camB));

  await page.waitForFunction((n) => document.querySelectorAll("[data-settings-card]").length >= n, camIds.length);
  const cardIds = (await page.locator("[data-settings-card]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-settings-card"))))).sort((x, y) => x - y);
  assert.deepEqual(cardIds, camIds, "đếm nút ⚙ trên thẻ phải bằng số camera");
  assert.equal(await page.locator("[data-settings-frame]").count(), 1, "khung hình live có đúng 1 nút ⚙");
});

/* ============ 2. Drawer 5 mục đúng nhãn + Chưa khả dụng + không reload stream ============ */

test("drawer mở tại chỗ đủ 5 mục đúng thứ tự; Lưu video/Tính tiền/Xem lại/vẽ ROI → Chưa khả dụng", async () => {
  const frameEl = await page.locator(".aspect-video").first().locator("img, video").first().elementHandle();
  assert.ok(frameEl, "phải có phần tử stream trên khung hình");

  // Capabilities giả lập tường minh: recorder/segments thật của máy chạy không được lái ca này.
  const unroute = await stubCapabilities(camA, {
    live: true, playback: false, record: false, snapshot: true, ask: true, pricing: false,
    reason: { record: "Chưa cấu hình ghi hình", pricing: "Chưa có nhận diện sản phẩm" },
  }, {
    featureFlags: FLAGS_ON,
    // Mục "Lưu trữ & cảnh báo" chỉ render khi camera thật sự bật ghi hình
    // (`feat.record` lấy từ cột record_enabled, không phải khoá features).
    recordEnabled: true,
  });
  try {
    await openDrawer(camA);
    assert.ok(page.url().startsWith(base + "/camera"), "mở drawer không rời trang live");
    const frameEl2 = await page.locator(".aspect-video").first().locator("img, video").first().elementHandle();
    assert.ok(await page.evaluate(([x, y]) => x === y, [frameEl, frameEl2]), "phần tử stream không bị thay thế khi mở drawer");

    const sections = await dlg().locator("section").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    // P1: thêm mục "Tính năng camera" (bật/tắt tính năng của riêng camera này);
    // "Ảnh & ghi chú" chỉ có mặt vì FLAGS_ON bật `product`.
    assert.deepEqual(sections, [
      "Thông tin & vị trí", "Tính năng AI", "Tính năng camera",
      "Ảnh & ghi chú", "Khu vực & quy tắc", "Lưu trữ & cảnh báo",
    ]);

    for (const key of ["playback", "record", "pricing"]) {
      const row = aiSection().locator(`[data-feature="${key}"]`);
      assert.match(await row.innerText(), /Chưa khả dụng/, `${key} phải ghi Chưa khả dụng`);
      assert.equal(await row.locator('[role="switch"]').isDisabled(), true, `${key} phải disabled`);
    }
    for (const key of ["live", "snapshot", "ask"]) {
      assert.equal(await aiSection().locator(`[data-feature="${key}"] [role="switch"]`).isEnabled(), true, `${key} phải dùng được`);
    }

    const zone = dlg().locator('section[aria-label="Khu vực & quy tắc"]');
    assert.equal(await zone.getByRole("button", { name: "Vẽ khu vực" }).isDisabled(), true);
    assert.match(await zone.innerText(), /Chưa khả dụng/);
  } finally {
    await closeDrawer();
    await unroute();
  }
});

/* ============ 2c. Tắt tính năng ⇒ mục của nó biến mất (spec per-camera) ============ */

test("tắt `product` ⇒ không còn mục 'Ảnh & ghi chú'; bật lại ⇒ mục trở lại", async () => {
  const unroute = await stubCapabilities(
    camA,
    { live: true, playback: true, record: true, snapshot: true, ask: true, pricing: false },
    { featureFlags: { ...FLAGS_ON, product: false } },
  );
  try {
    await openDrawer(camA);
    const labels = await dlg().locator("section").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    assert.ok(!labels.includes("Ảnh & ghi chú"), `product tắt ⇒ không được có mục ảnh; nhận ${JSON.stringify(labels)}`);
    assert.ok(labels.includes("Tính năng camera"), "mục bật/tắt tính năng luôn phải có");
  } finally {
    await closeDrawer();
    await unroute();
  }

  const on = await stubCapabilities(
    camA,
    { live: true, playback: true, record: true, snapshot: true, ask: true, pricing: false },
    { featureFlags: FLAGS_ON },
  );
  try {
    await openDrawer(camA);
    const labels = await dlg().locator("section").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    assert.ok(labels.includes("Ảnh & ghi chú"), `product bật ⇒ phải có mục ảnh; nhận ${JSON.stringify(labels)}`);
  } finally {
    await closeDrawer();
    await on();
  }
});

/* ============ 2b. Capabilities mở record/playback ⇒ switch dùng được; pricing vẫn khoá ============ */

test("capabilities record/playback=true ⇒ 'Ghi hình liên tục' không disabled + aria-checked=recordEnabled; 'Tính tiền' vẫn Chưa khả dụng", async () => {
  const unroute = await stubCapabilities(camA, {
    live: true, playback: true, record: true, snapshot: true, ask: true, pricing: false,
    reason: { pricing: "Chưa có nhận diện sản phẩm" },
  }, { recordEnabled: true });
  try {
    await openDrawer(camA);

    // Hàng "Ghi hình liên tục" trong mục Lưu trữ & cảnh báo.
    const recRow = dlg().locator('[data-flag="record"]');
    const recSwitch = recRow.locator('button[role="switch"]');
    await recSwitch.waitFor();
    assert.equal(await recSwitch.isDisabled(), false, "capabilities.record=true ⇒ 'Ghi hình liên tục' không disabled");
    assert.equal(await recSwitch.getAttribute("aria-checked"), "true", "aria-checked phải bằng recordEnabled trong settings");
    assert.doesNotMatch(await recRow.innerText(), /Chưa khả dụng/, "recorder khả dụng ⇒ 'Ghi hình liên tục' hết badge");

    for (const key of ["playback", "record"] as const) {
      const row = aiSection().locator(`[data-feature="${key}"]`);
      const text = await row.innerText();
      assert.match(text, key === "record" ? /Lưu video/ : /Xem lại/, `${key} phải đúng nhãn`);
      assert.doesNotMatch(text, /Chưa khả dụng/, `${key} khả dụng ⇒ hết badge Chưa khả dụng`);
      assert.equal(await row.locator('[role="switch"]').isDisabled(), false, `${key} phải dùng được`);
    }
    const pricingRow = aiSection().locator('[data-feature="pricing"]');
    assert.match(await pricingRow.innerText(), /Chưa khả dụng/, "pricing vẫn khoá phase này");
    assert.equal(await pricingRow.locator('[role="switch"]').isDisabled(), true, "pricing vẫn disabled");
  } finally {
    await closeDrawer();
    await unroute();
  }
});

/* ============ 3. Toggle tính năng: PATCH đúng cameraId, revision tăng; camera B không đổi ============ */

test("toggle ở camera A PATCH đúng id + revision tăng; GET camera B không đổi", async () => {
  await openDrawer(camA);
  const sw = aiSection().locator('[data-feature="live"] [role="switch"]');
  await page.waitForSelector('[data-feature="live"] [role="switch"][aria-checked="true"]');

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/cameras/${camA}/settings`) && r.request().method() === "PATCH"),
    sw.click(),
  ]);
  assert.equal(resp.status(), 200);
  const sent = JSON.parse(resp.request().postData()!);
  assert.equal(sent.revision, 1, "PATCH phải gửi revision hiện tại");
  const body = await resp.json();
  assert.equal(body.revision, 2, "revision tăng sau PATCH");
  assert.equal(body.features.live, false);

  const b = await call(`/api/cameras/${camB}/settings`);
  assert.equal(b.data.revision, 1, "camera B không bị ảnh hưởng");
  assert.deepEqual(b.data.features, {});
});

/* ============ 4. 409: UI thông báo + tải bản mới, không ghi đè ============ */

test("PATCH revision cũ → UI hiện 'Cài đặt đã thay đổi ở nơi khác', không ghi đè", async () => {
  await openDrawer(camA);
  // Bên ngoài drawer (tab khác) đẩy revision 2 → 3.
  const ext = await call(`/api/cameras/${camA}/settings`, "PATCH", { revision: 2, retentionDays: 33 });
  assert.equal(ext.status, 200);
  assert.equal(ext.data.revision, 3);

  const sw = aiSection().locator('[data-feature="snapshot"] [role="switch"]');
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/cameras/${camA}/settings`) && r.request().method() === "PATCH"),
    sw.click(),
  ]);
  assert.equal(resp.status(), 409, "UI phải nhận 409 khi revision lạc hậu");
  await dlg().getByText("Cài đặt đã thay đổi ở nơi khác").waitFor({ timeout: 5000 });

  const cur = await call(`/api/cameras/${camA}/settings`);
  assert.equal(cur.data.revision, 3);
  assert.equal(cur.data.retentionDays, 33, "bản mới của tab kia giữ nguyên — không ghi đè");
  assert.ok(!("snapshot" in cur.data.features), "ghi stale phải không áp dụng");
});

/* ============ 5. Ghi chú từng ảnh qua UI ============ */

test("gắn 2 ảnh cùng mục, sửa note 1 ảnh, ảnh kia giữ nguyên", async () => {
  // Mục "Ảnh & ghi chú" chỉ render khi camera bật tính năng hàng hoá (P1).
  // Ca trước để drawer mở với settings thật — đóng lại để openDrawer nạp qua stub.
  await closeDrawer();
  const unroute = await stubCapabilities(
    camA,
    { live: true, playback: true, record: true, snapshot: true, ask: true, pricing: false },
    { featureFlags: FLAGS_ON },
  );
  await openDrawer(camA);
  const sec = dlg().locator('section[aria-label="Ảnh & ghi chú"]');
  await sec.locator('input[aria-label="Tiêu đề mục"]').fill(`${prefix} mục UX`);
  await sec.locator('input[aria-label="Ghi chú mục mới"]').fill("ghi chú mục");
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/knowledge/items") && r.request().method() === "POST"),
    sec.getByRole("button", { name: "Thêm mục" }).click(),
  ]);
  const item = await created.json();
  assert.equal(created.status(), 201, JSON.stringify(item));
  itemIds.push(item.id);

  await sec.locator(`[data-item="${item.id}"]`).getByRole("button", { name: "Mở" }).click();
  await sec.getByText(/Ảnh đính kèm/).waitFor();

  await sec.getByRole("button", { name: "Thêm ảnh từ sự kiện" }).click();
  for (const assetId of [a1, a2]) {
    const [r] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/knowledge/items/${item.id}/images`) && r.request().method() === "POST"),
      sec.locator(`[data-asset="${assetId}"]`).click(),
    ]);
    assert.equal(r.status(), 201, JSON.stringify(await r.json()));
  }

  const block1 = sec.locator("[data-image]", { has: page.locator(`img[src*="/api/assets/${a1}"]`) });
  await block1.locator('textarea[aria-label="Ghi chú ảnh"]').fill("ghi chú ảnh một");
  const [saved] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/knowledge/images/") && r.request().method() === "PATCH"),
    block1.locator('button[aria-label="Lưu ghi chú ảnh"]').click(),
  ]);
  assert.equal(saved.status(), 200);

  const g = await call(`/api/knowledge/items/${item.id}`);
  const byAsset = new Map<number, string | null>((g.data.images as { assetId: number; note: string | null }[]).map((im) => [im.assetId, im.note]));
  assert.equal(byAsset.get(a1), "ghi chú ảnh một");
  assert.equal(byAsset.get(a2), null, "ghi chú ảnh kia giữ nguyên");
  await unroute();
});

/* ============ 6. UI không có chuỗi nội bộ ============ */

test("grep UI không có chuỗi nội bộ trong các file của tính năng", () => {
  const re = /hermes|worker|gpu|gateway|model|vector|token/i;
  const files = [
    "src/components/CameraSettingsDrawer.tsx",
    "src/components/CameraView.tsx",
    "src/app/camera/page.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const m = src.match(re);
    assert.equal(m, null, `${f} chứa chuỗi nội bộ: ${m?.[0]}`);
  }
});

/* ============ Mobile 390px ============ */

test("mobile 390px: drawer toàn chiều rộng, không tràn ngang", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + "/camera");
  await openDrawer(camA);
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(scrollW <= 390, `scrollWidth=${scrollW} vượt 390px`);
  const box = await dlg().boundingBox();
  assert.ok(box && box.width <= 390 && box.width > 300, `drawer width=${box?.width} phải ~toàn chiều rộng`);
  assert.deepEqual(pageErrors, [], "không được có lỗi JS nào trong phiên trình duyệt");
});

/* ============ 7. Trang chủ: khung chat compact tự cuộn, không kéo dài trang ============ */

test("trang chủ: khung chat compact giới hạn theo viewport, chỉ vùng tin nhắn cuộn", async () => {
  // Stub GET /api/chat: 4 tin assistant với answer.short ~1500 ký tự + ảnh bằng chứng,
  // đủ nội dung để tràn khung nếu layout không giới hạn chiều cao.
  const filler = "Nội dung phân tích camera dài ".repeat(55);
  const history = [1, 2, 3, 4].map((id) => ({
    id,
    tenantId: 1,
    role: "assistant",
    text: `CÂU TRẢ LỜI DÀI ${id}`,
    inputMode: "text",
    createdAt: new Date().toISOString(),
    answer: {
      short: `CÂU TRẢ LỜI DÀI ${id} — ${filler}`,
      kind: "DETERMINISTIC_AGGREGATION",
      execution: { path: "fast", durationMs: 9, reason: "fixture" },
      details: Array.from({ length: 6 }, (_, i) => `Chi tiết ${i + 1}: ${"số liệu thống kê ".repeat(12)}`),
      evidence: [0, 1, 2].map((i) => ({ label: `Bằng chứng ${i + 1}`, time: `10:0${i}`, thumb: `/api/assets/${i === 2 ? a2 : a1}` })),
      evidenceCount: 3,
      nextActions: [],
      chart: [
        { label: "h1", value: 4 }, { label: "h2", value: 7 }, { label: "h3", value: 3 },
        { label: "h4", value: 9 }, { label: "h5", value: 5 }, { label: "h6", value: 2 },
      ],
      warnings: [],
    },
  }));
  const handler = async (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: history });
  };
  await page.route("**/api/chat", handler);

  const measure = () =>
    page.evaluate(() => {
      const mic = document.querySelector('button[aria-label="Nhấn để nói"]');
      const frame = mic?.closest("div.glass") ?? null;
      const list = frame?.querySelector("div.overflow-y-auto") ?? null;
      const composer = frame?.querySelector("div.border-t") ?? null;
      const input = frame?.querySelector('input[aria-label="Câu hỏi"]');
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        docScrollWidth: document.documentElement.scrollWidth,
        docScrollHeight: document.documentElement.scrollHeight,
        isChat: Boolean(frame?.textContent?.includes("Trợ lý AI")),
        frame: frame?.getBoundingClientRect().toJSON() ?? null,
        listClientH: list?.clientHeight ?? 0,
        listScrollH: list?.scrollHeight ?? 0,
        mic: mic?.getBoundingClientRect().toJSON() ?? null,
        composer: composer?.getBoundingClientRect().toJSON() ?? null,
        input: input?.getBoundingClientRect().toJSON() ?? null,
      };
    });

  type M = Awaited<ReturnType<typeof measure>>;
  const checkFrame = (m: M, label: string) => {
    assert.ok(m.isChat, `${label}: không tìm thấy khung chat (div.glass chứa 'Trợ lý AI')`);
    assert.ok(m.frame, `${label}: thiếu khung chat`);
    assert.ok(
      m.frame!.height <= 0.9 * m.innerHeight,
      `${label}: khung chat cao ${m.frame!.height.toFixed(0)}px > 0.9 × innerHeight ${m.innerHeight}px`,
    );
    assert.ok(
      m.listScrollH > m.listClientH,
      `${label}: vùng tin nhắn phải tự cuộn (scrollHeight=${m.listScrollH} > clientHeight=${m.listClientH})`,
    );
    for (const [name, r] of [["mic", m.mic], ["composer", m.composer]] as const) {
      const inside = r !== null && r.top >= m.frame!.top - 1 && r.bottom <= m.frame!.bottom + 1;
      assert.ok(
        inside,
        `${label}: ${name} phải nằm cố định trong khung chat (top=${r?.top.toFixed(0) ?? "?"} bottom=${r?.bottom.toFixed(0) ?? "?"} frame=${m.frame!.top.toFixed(0)}..${m.frame!.bottom.toFixed(0)})`,
      );
    }
  };

  try {
    // Desktop 1440×900
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base + "/");
    await page.getByText("CÂU TRẢ LỜI DÀI 4", { exact: false }).first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(400);
    const desk = await measure();
    console.log(`[chat-scroll] desktop ${JSON.stringify(desk)}`);
    checkFrame(desk, "desktop");

    // Mở bàn phím ⇒ ô nhập cũng phải nằm trong khung.
    await page.locator('button[aria-label="Bàn phím"]').click();
    await page.locator('input[aria-label="Câu hỏi"]').waitFor({ timeout: 5000 });
    const deskInput = await measure();
    console.log(`[chat-scroll] desktop+keyboard ${JSON.stringify(deskInput)}`);
    assert.ok(
      deskInput.input && deskInput.frame &&
        deskInput.input.top >= deskInput.frame.top - 1 && deskInput.input.bottom <= deskInput.frame.bottom + 1,
      "desktop: ô nhập phải nằm trong khung chat",
    );

    // Mobile 390×844
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const mob = await measure();
    console.log(`[chat-scroll] mobile ${JSON.stringify(mob)}`);
    checkFrame(mob, "mobile");
    assert.ok(mob.docScrollWidth <= mob.innerWidth, `mobile: scrollWidth=${mob.docScrollWidth} vượt innerWidth=${mob.innerWidth}`);
  } finally {
    await page.unroute("**/api/chat", handler);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});
