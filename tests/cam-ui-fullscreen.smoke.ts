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
    const zoom = page.locator('button[aria-label="Phóng to"]').first();
    await zoom.waitFor({ timeout: 30000 });
    check("nút Phóng to hiển thị", await zoom.isVisible());
  
    // 1) Vào fullscreen bằng nút
    await zoom.click();
    await page.waitForTimeout(700);
    const fsAfterEnter = await page.evaluate(() => Boolean(document.fullscreenElement));
    check("requestFullscreen → document.fullscreenElement có giá trị", fsAfterEnter);
  
    const exitBtn = page.locator('button[aria-label="Thoát toàn màn hình"]').first();
    const exitVisible = await exitBtn.isVisible().catch(() => false);
    check("nút Thoát toàn màn hình xuất hiện khi đang fullscreen", exitVisible);
  
    // 2) Thoát bằng nút
    if (exitVisible) {
      await exitBtn.click();
      await page.waitForTimeout(700);
      const fsAfterExit = await page.evaluate(() => Boolean(document.fullscreenElement));
      check("nhấn Thoát → rời fullscreen", !fsAfterExit);
      const stillThere = await exitBtn.isVisible().catch(() => false);
      check("nút Thoát biến mất sau khi thoát", !stillThere);
    }
  
    // 3) Vào lại rồi thoát bằng ESC
    await zoom.click();
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
      const exitGone = await page.locator('button[aria-label="Thoát toàn màn hình"]').count();
      check("nút Thoát biến mất sau khi thoát (đồng bộ fullscreenchange)", exitGone === 0);
    }
  
    // 4) Viewport mobile: cảm ứng chạm được nút
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const zoomM = page.locator('button[aria-label="Phóng to"]').first();
    const box = await zoomM.boundingBox();
    check("nút Phóng to có kích thước chạm ≥ 32px trên mobile", Boolean(box && box.width >= 32 && box.height >= 32), box ? `${Math.round(box.width)}×${Math.round(box.height)}` : "no box");
    await zoomM.click();
    await page.waitForTimeout(700);
    const fsMobile = await page.evaluate(() => Boolean(document.fullscreenElement));
    const exitMobile = await page.locator('button[aria-label="Thoát toàn màn hình"]').isVisible().catch(() => false);
    check("mobile: vào fullscreen + thấy nút Thoát", fsMobile && exitMobile);
    if (fsMobile) await page.evaluate(() => document.exitFullscreen?.()).catch(() => {});
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

