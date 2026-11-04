// Smoke thật cho CAM-UI-001: vào/ra toàn màn hình bằng nút + bằng ESC.
// Chạy: DAI_TEST_BASE_URL=http://localhost:3000 node --import tsx tests/cam-ui-fullscreen.smoke.ts
import "dotenv/config";
import { chromium } from "@playwright/test";
import { randomBytes, scryptSync } from "node:crypto";
import { ensureDefaultTenant } from "./helpers/tenant";
import { db } from "../src/db";
import { users } from "../src/db/schema";
import { eq } from "drizzle-orm";

const base = process.env.DAI_TEST_BASE_URL ?? "http://localhost:3000";
const results: string[] = [];
let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
}

const name = `smoke_fs_${randomBytes(5).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const salt = randomBytes(16).toString("hex");
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
let userId: number | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

async function main() {
  try {
    await ensureDefaultTenant();
    const [u] = await db.insert(users).values({ login: name, displayName: name, role: "owner", passwordHash }).returning();
    userId = u.id;
    check("tạo user owner tạm", Boolean(userId));
  
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
  
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "Tên đăng nhập", exact: true }).fill(name);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    await page.waitForURL(`${base}/`, { timeout: 30000 });
    check("đăng nhập owner", true);
  
    await page.goto(`${base}/camera`, { waitUntil: "domcontentloaded" });
    // Nút fullscreen là 1 nút toggle: nhãn đổi giữa "Phóng to" và "Thu nhỏ".
    // Dùng selector theo data attribute để locator không bị stale khi nhãn đổi.
    const fsBtn = page.locator('button[data-fs-toggle]').first();
    await fsBtn.waitFor({ timeout: 30000 });
    const zoom = page.locator('button[aria-label="Phóng to"]').first();
    check("nút Phóng to hiển thị", await zoom.isVisible());
  
    // 1) Vào fullscreen bằng nút
    await fsBtn.click();
    await page.waitForTimeout(700);
    const fsAfterEnter = await page.evaluate(() => Boolean(document.fullscreenElement));
    check("requestFullscreen → document.fullscreenElement có giá trị", fsAfterEnter);
  
    const exitBtn = page.locator('button[aria-label="Thu nhỏ"]').first();
    const exitVisible = await exitBtn.isVisible().catch(() => false);
    check("nút Thu nhỏ xuất hiện khi đang fullscreen", exitVisible);
  
    // 2) Thoát bằng nút
    if (exitVisible) {
      await exitBtn.click();
      await page.waitForTimeout(700);
      const fsAfterExit = await page.evaluate(() => Boolean(document.fullscreenElement));
      check("nhấn Thoát → rời fullscreen", !fsAfterExit);
      const stillThere = await exitBtn.isVisible().catch(() => false);
      check("nút Thoát biến mất sau khi thoát", !stillThere);
    }

    // 2b) NGHIỆM THU Sếp: bấm lại ĐÚNG nút đó (nút Phóng to) phải thu nhỏ.
    // Bản 2-nút: nút "Phóng to" vẫn gọi requestFullscreen() ⇒ no-op ⇒ FAIL.
    await fsBtn.click();
    await page.waitForTimeout(700);
    const fsToggleIn = await page.evaluate(() => Boolean(document.fullscreenElement));
    check("bấm nút lần 1 → vào fullscreen", fsToggleIn);
    if (fsToggleIn) {
      await fsBtn.click(); // bấm lại đúng nút đó
      await page.waitForTimeout(900);
      const fsToggleOut = await page.evaluate(() => Boolean(document.fullscreenElement));
      check("bấm lại đúng nút đó → thoát fullscreen (toggle 1 nút)", !fsToggleOut);
      const zoomLabelAfter = await page
        .locator('button[aria-label="Phóng to"]')
        .first()
        .isVisible()
        .catch(() => false);
      check("sau khi thoát, nút trở lại nhãn Phóng to", zoomLabelAfter);
    }

    // 3) Vào lại rồi thoát bằng ESC
    await fsBtn.click();
    await page.waitForTimeout(700);
    const fsRe = await page.evaluate(() => Boolean(document.fullscreenElement));
    check("vào fullscreen lần 2", fsRe);
    if (fsRe) {
      // Headless Chromium không nhận ESC để thoát fullscreen như browser thật.
      // Dùng API gốc để mô phỏng đúng đường fullscreenchange (nhánh UI phải bắt được).
      await page.evaluate(() => document.exitFullscreen?.()).catch(() => {});
      await page.waitForTimeout(900);
      const fsEsc = await page.evaluate(() => Boolean(document.fullscreenElement));
      check("thoát fullscreen → document.fullscreenElement rỗng", !fsEsc);
      // Biểu tượng/nhãn phải tự cập nhật theo fullscreenchange (không cần bấm nút).
      const zoomBack = await page
        .locator('button[aria-label="Phóng to"]')
        .first()
        .isVisible()
        .catch(() => false);
      const shrinkGone = (await page.locator('button[aria-label="Thu nhỏ"]').count()) === 0;
      check("thoát bằng ESC → nút tự về nhãn Phóng to", zoomBack && shrinkGone);
    }

    // 4) Viewport mobile: cảm ứng chạm được nút
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const fsM = page.locator('button[data-fs-toggle]').first();
    const box = await fsM.boundingBox();
    check("nút Phóng to có kích thước chạm ≥ 32px trên mobile", Boolean(box && box.width >= 32 && box.height >= 32), box ? `${Math.round(box.width)}×${Math.round(box.height)}` : "no box");
    await fsM.click();
    await page.waitForTimeout(700);
    const fsMobile = await page.evaluate(() => Boolean(document.fullscreenElement));
    const shrinkMobile = await page.locator('button[aria-label="Thu nhỏ"]').first().isVisible().catch(() => false);
    check("mobile: vào fullscreen + nút đổi nhãn Thu nhỏ", fsMobile && shrinkMobile);
    if (fsMobile) {
      // Chạm lại đúng nút đó trên mobile ⇒ thu nhỏ.
      await fsM.click();
      await page.waitForTimeout(800);
      const fsMobileOut = await page.evaluate(() => Boolean(document.fullscreenElement));
      check("mobile: chạm lại nút Thu nhỏ → thoát fullscreen", !fsMobileOut);
    }
    await page.waitForTimeout(500);
  
    check("không có pageerror trong suốt luồng", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } catch (e) {
    check("script chạy không exception", false, (e as Error).message);
  } finally {
    try { if (browser) await browser.close(); } catch {}
    try { if (userId) await db.delete(users).where(eq(users.id, userId)); } catch {}
    console.log("\n=== KẾT QUẢ SMOKE FULLSCREEN ===");
    for (const r of results) console.log(r);
    console.log(`\nTỔNG: ${results.filter(r => r.startsWith("PASS")).length} pass / ${failed} fail`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

void main();

