import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { eq, inArray, like } from "drizzle-orm";
import { ensureDefaultTenant } from "./helpers/tenant";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { cleanupKnowledgeItems } from "./helpers/knowledge";
import { db, pool } from "../src/db";
import { aiJobs, assets, auditLog, cameras, productEmbeddings, sessions, users } from "../src/db/schema";

/**
 * CAM-MEDIA-003 — khối "Tải ảnh/video lên" trong drawer cài đặt camera:
 * input file ẩn (label btn-ghost), preview ảnh / tên+dung lượng video,
 * ghi chú riêng từng tệp (≤500), giá VND chỉ cho ảnh, nút "Lưu vào trí nhớ AI".
 * Backend hiện tại chỉ nhận gắn kind=image vào mục (attachImage) — video được
 * lưu vào kho asset của camera và UI gắn nhãn "Chờ xử lý" (không coi là đã học).
 * Server: `next start` thật + Chromium thật (như t1336). Fixture dọn sạch trong after().
 */
const prefix = `cm003_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let app: ChildProcess, base: string;
let browser: Browser, context: BrowserContext, page: Page;
let ownerId = 0, camId = 0, itemId = 0;
const itemIds: number[] = [];
const assetIds: number[] = [];
const cookies: Record<string, string> = {};
const call: Call = makeCall(() => base);
let logs = "";
const pageErrors: string[] = [];

const dlg = () => page.locator('[role="dialog"][aria-label="Cài đặt camera"]');
const sec = () => dlg().locator('section[aria-label="Ảnh & ghi chú"]');
const up = () => sec().locator("[data-upload]");

async function openDrawer(id: number) {
  if (!(await dlg().isVisible().catch(() => false))) {
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/cameras/${id}/settings`) && r.request().method() === "GET"),
      page.locator(`[data-settings-card="${id}"]`).click(),
    ]);
    assert.equal(res.status(), 200, "GET settings phải thành công khi mở drawer");
  }
  await dlg().waitFor({ state: "visible" });
}

async function closeDrawer() {
  if (!(await dlg().isVisible().catch(() => false))) return;
  await dlg().locator('button[aria-label="Đóng cài đặt"]').click();
  await dlg().waitFor({ state: "hidden" });
}

/** MP4/WebM tối thiểu đủ magic bytes (sniff server: offset 4-8 = "ftyp"). */
const mp4Buf = () =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.from([0, 0, 2, 0]), Buffer.from("isomiso2"), Buffer.alloc(64)]);

before(async () => {
  // Fixture cần production build cho `next start` — build một lần nếu chưa có.
  if (!existsSync(".next/BUILD_ID")) {
    const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { stdio: "inherit" });
    assert.equal(r.status, 0, "next build thất bại (fixture cần `next start`)");
  }

  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  await ensureDefaultTenant();
  const [owner] = await db
    .insert(users)
    .values({ login: `${prefix}_owner`, displayName: `${prefix}_owner`, role: "owner", passwordHash })
    .returning();
  ownerId = owner.id;
  const [cam] = await db
    .insert(cameras)
    .values({ code: `${prefix}-cam`, name: `${prefix} cam`, location: "Fixture", sourceType: "demo", status: "demo" })
    .returning();
  camId = cam.id;

  const appPort = await freePort();
  base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], {
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", (s) => (logs = (logs + s).slice(-10000)));
  app.stderr?.on("data", (s) => (logs = (logs + s).slice(-10000)));
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(base + "/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await wait(100);
  }
  assert.ok(ready, logs);

  cookies.owner = await loginUser(call, prefix, password, "owner");

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
}, { timeout: 300000 });

after(async () => {
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  await context?.close();
  await browser?.close();
  if (itemIds.length) {
    await db.delete(productEmbeddings).where(inArray(productEmbeddings.itemId, itemIds));
    await cleanupKnowledgeItems(itemIds);
  }
  if (assetIds.length) await db.delete(assets).where(inArray(assets.id, assetIds));
  if (camId) await db.delete(cameras).where(eq(cameras.id, camId)); // camera_settings cascade
  if (ownerId) {
    await db.delete(aiJobs).where(eq(aiJobs.userId, ownerId)); // job asset.index enqueue lúc upload
    await db.delete(sessions).where(eq(sessions.userId, ownerId));
    await db.delete(users).where(eq(users.id, ownerId));
  }
  await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
  await pool.end();
}, { timeout: 20000 });

/* ============ 1. Khối upload + chặn client-side: >25MB, sai MIME ============ */

test("khối 'Tải ảnh/video lên' có input đúng accept; >25MB và sai MIME báo lỗi tiếng Việt, không gọi API", async () => {
  await openDrawer(camId);

  // Tạo mục + mở detail (upload cần mục đang mở để gắn vào).
  await sec().locator('input[aria-label="Tiêu đề mục"]').fill(`${prefix} mục up`);
  await sec().locator('input[aria-label="Ghi chú mục mới"]').fill("ghi chú mục");
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/knowledge/items") && r.request().method() === "POST"),
    sec().getByRole("button", { name: "Thêm mục" }).click(),
  ]);
  const item = await created.json();
  assert.equal(created.status(), 201, JSON.stringify(item));
  itemId = item.id;
  itemIds.push(itemId);

  await sec().locator(`[data-item="${itemId}"]`).getByRole("button", { name: "Mở" }).click();
  await sec().getByText(/Ảnh đính kèm/).waitFor();
  await up().waitFor();

  const fileInput = up().locator("[data-upload-input]");
  assert.equal(
    await fileInput.getAttribute("accept"),
    "image/jpeg,image/png,image/webp,video/webm,video/mp4",
    "accept phải khớp danh sách MIME của thẻ",
  );

  // >25 MB: chặn ngay khi chọn, không bắn request upload nào.
  const assetsP = page.waitForRequest((r) => r.url().endsWith("/api/assets") && r.method() === "POST", { timeout: 3000 }).then(() => true).catch(() => false);
  await fileInput.setInputFiles({ name: "lon.png", mimeType: "image/png", buffer: Buffer.alloc(26 * 1024 * 1024) });
  await up().locator("[data-upload-error]").waitFor();
  assert.match(await up().locator("[data-upload-error]").innerText(), /Tệp quá lớn.*25 MB/);
  assert.equal(await assetsP, false, "tệp quá lớn không được gửi lên server");

  // Sai MIME: text/plain không nằm trong danh sách.
  await fileInput.setInputFiles({ name: "doc.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await up().locator("[data-upload-error]").waitFor();
  assert.match(await up().locator("[data-upload-error]").innerText(), /Định dạng không hỗ trợ/);
});

/* ============ 2. Ảnh PNG: preview + ghi chú + giá → lưu → gắn + set giá + flash Đã lưu ============ */

test("upload ảnh PNG: preview, ghi chú riêng + giá VND lưu cùng lúc gắn; mục vẫn mở, flash Đã lưu", async () => {
  assert.ok(itemId, "test 1 phải tạo mục trước");
  const png = await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 200, g: 40, b: 60 } } }).png().toBuffer();

  await up().locator("[data-upload-input]").setInputFiles({ name: "sanpham.png", mimeType: "image/png", buffer: png });
  const preview = up().locator('img[alt="Ảnh xem trước"]');
  await preview.waitFor();
  assert.match((await preview.getAttribute("src")) ?? "", /^blob:/, "preview phải là object-URL cục bộ");
  assert.match(await up().innerText(), /sanpham\.png/);
  assert.equal(await up().locator("[data-upload-note]").getAttribute("maxlength"), "500", "ghi chú tệp giới hạn 500 ký tự");

  await up().locator("[data-upload-note]").fill("ghi chú riêng file png");
  await up().locator("[data-upload-price]").fill("15000");

  const assetP = page.waitForResponse((r) => r.url().endsWith("/api/assets") && r.request().method() === "POST");
  const attachP = page.waitForResponse((r) => r.url().includes(`/api/knowledge/items/${itemId}/images`) && r.request().method() === "POST");
  const priceP = page.waitForResponse((r) => r.url().includes(`/api/knowledge/items/${itemId}/price`) && r.request().method() === "POST");
  await up().locator("[data-upload-save]").click();
  const [assetRes, attachRes, priceRes] = await Promise.all([assetP, attachP, priceP]);

  assert.equal(assetRes.status(), 201, JSON.stringify(await assetRes.json()));
  const assetBody = await assetRes.json();
  assetIds.push(assetBody.id);
  assert.equal(assetBody.mime, "image/jpeg", "ảnh tải lên chuẩn hoá JPEG như luồng /extract");
  assert.equal(attachRes.status(), 201, JSON.stringify(await attachRes.json()));
  assert.equal(priceRes.status(), 200, "giá VND phải lưu qua /price");

  // Danh sách ảnh refresh: hàng data-image mới có note; item vẫn đang mở.
  const row = sec().locator(`[data-image]`, { has: page.locator(`img[src*="/api/assets/${assetBody.id}"]`) });
  await row.waitFor({ timeout: 60000 }); // embed có thể chạy vài giây trước khi refresh
  const g = await call(`/api/knowledge/items/${itemId}`, "GET", undefined, cookies.owner);
  const byAsset = new Map<number, string | null>((g.data.images as { assetId: number; note: string | null }[]).map((im) => [im.assetId, im.note]));
  assert.equal(byAsset.get(assetBody.id), "ghi chú riêng file png", "ghi chú riêng của tệp phải vào note ảnh");
  assert.equal(g.data.priceVnd, 15000, "giá VND phải cập nhật trên mục");
  assert.ok((g.data.priceHistory as { priceVnd: number }[]).some((h) => h.priceVnd === 15000), "lịch sử giá phải có mốc 15000");
  await sec().getByText(/Ảnh đính kèm \(1\)/).waitFor();
  await dlg().getByText(/Đã lưu/).waitFor({ timeout: 5000 });
});

/* ============ 3. Video MP4: chỉ tên+dung lượng, không ô giá; lưu → "Chờ xử lý" ============ */

test("upload video MP4: không ô giá; attach 404 (backend chỉ nhận ảnh) → nhãn Chờ xử lý, asset vẫn lưu kho camera", async () => {
  assert.ok(itemId, "test 1 phải tạo mục trước");
  await up().locator("[data-upload-input]").setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: mp4Buf() });

  assert.equal(await up().locator("[data-upload-price]").count(), 0, "video không hiện ô giá");
  assert.match(await up().innerText(), /clip\.mp4/, "video hiện tên tệp");
  assert.match(await up().innerText(), /KB|MB/, "video hiện dung lượng");
  assert.match(await up().innerText(), /chờ xử lý/i, "video báo trước trạng thái chờ");
  await up().locator("[data-upload-note]").fill("clip thử");

  const assetP = page.waitForResponse((r) => r.url().endsWith("/api/assets") && r.request().method() === "POST");
  const attachP = page.waitForResponse((r) => r.url().includes(`/api/knowledge/items/${itemId}/images`) && r.request().method() === "POST");
  await up().locator("[data-upload-save]").click();
  const [assetRes, attachRes] = await Promise.all([assetP, attachP]);

  assert.equal(assetRes.status(), 201, JSON.stringify(await assetRes.json()));
  const assetBody = await assetRes.json();
  assetIds.push(assetBody.id);
  assert.equal(assetBody.mime, "video/mp4", "server sniff magic bytes ra video/mp4");
  assert.equal(attachRes.status(), 404, "backend hiện tại từ chối gắn kind=video vào mục — đây là lý do UI hiện Chờ xử lý");

  const pend = up().locator(`[data-pending-video="${assetBody.id}"]`);
  await pend.waitFor({ timeout: 30000 });
  const pendText = await pend.innerText();
  assert.match(pendText, /Chờ xử lý/);
  assert.match(pendText, /clip\.mp4/);
  assert.match(pendText, /clip thử/, "ghi chú riêng của video vẫn hiển thị");

  // Asset video thật sự nằm trong kho của camera (origin=upload, đúng owner).
  const [row] = await db.select().from(assets).where(eq(assets.id, assetBody.id));
  assert.equal(row.kind, "video");
  assert.equal(row.origin, "upload");
  assert.equal(row.cameraId, camId);
  assert.equal(row.userId, ownerId);
  const g = await call(`/api/knowledge/items/${itemId}`, "GET", undefined, cookies.owner);
  assert.equal((g.data.images as { assetId: number }[]).some((im) => im.assetId === assetBody.id), false, "video chưa gắn vào mục (backend chưa hỗ trợ)");
  await dlg().getByText(/Đã lưu video/).waitFor({ timeout: 5000 });
});

/* ============ 4. Không lỗi JS + attach-from-event không đổi ============ */

test("không có lỗi JS trong phiên; drawer đóng sạch", async () => {
  await closeDrawer();
  assert.deepEqual(pageErrors, [], "không được có lỗi JS nào trong phiên trình duyệt");
});
