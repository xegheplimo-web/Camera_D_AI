import "dotenv/config";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomBytes, scryptSync } from "node:crypto";
import sharp from "sharp";
import { db, pool } from "../src/db";
import { users, sessions, messages, aiJobs, assets, extractions, auditLog } from "../src/db/schema";
import { and, eq, inArray, like, or } from "drizzle-orm";

async function main() {
const base = process.env.DAI_TEST_BASE_URL ?? "http://localhost:3000";
const name = `browser_${randomBytes(6).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const salt = randomBytes(16).toString("hex");
let userId: number | undefined;
const assetIds = new Set<number>(), extractionIds = new Set<number>();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [], heavyDownloads: string[] = [];
const report: string[] = [];
const pendingResponses: Promise<void>[] = [];

try {
  const [user] = await db.insert(users).values({ login: name, displayName: name, role: "operator", passwordHash: `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}` }).returning();
  userId = user.id;
  await context.addInitScript(() => localStorage.setItem("dai_voice_out", "text"));
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (/tensorflow|tfjs|tesseract|coco-ssd|traineddata|model\.json/i.test(r.url())) heavyDownloads.push(r.url()); });
  page.on("response", (response) => {
    if (response.request().method() !== "POST") return;
    const p = new URL(response.url()).pathname;
    if (p !== "/api/assets" && p !== "/api/extractions") return;
    pendingResponses.push((async () => {
      if (!response.ok()) return;
      const body = await response.json();
      if (p === "/api/assets" && !body.duplicate) assetIds.add(body.id);
      if (p === "/api/extractions") { if (body.id) extractionIds.add(body.id); if (body.extractionId) extractionIds.add(body.extractionId); }
    })());
  });
  await page.goto(base + "/login");
  await page.getByRole("textbox", { name: "Tên đăng nhập", exact: true }).fill(name);
  await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
  await page.waitForURL(base + "/", { timeout: 25000 });
  report.push("PASS: isolated operator login");
  await mkdir("artifacts/screenshots", { recursive: true });

  for (const [width, height] of [[1440, 1000], [768, 1024], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height });
    await page.goto(base + "/orchestration");
    await page.getByRole("heading", { name: "Điều phối AI", exact: true }).waitFor();
    await page.getByText("Hai đường xử lý, một trải nghiệm", { exact: true }).waitFor();
    await page.waitForTimeout(500);
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflows) throw new Error(`Horizontal overflow at ${width}px`);
    report.push(`PASS: orchestration responsive ${width}x${height}`);
    if (width === 1440) await page.screenshot({ path: "artifacts/screenshots/orchestration-desktop.png", fullPage: true });
    if (width === 390) await page.screenshot({ path: "artifacts/screenshots/orchestration-mobile.png", fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + "/chat?question=" + encodeURIComponent("Hôm nay có bao nhiêu khách?"));
  await page.getByRole("textbox", { name: "Câu hỏi", exact: true }).waitFor();
  await page.getByRole("button", { name: "Gửi", exact: true }).click();
  await page.getByText("⚡ Gateway → SQL · không gọi Hermes", { exact: true }).first().waitFor({ timeout: 15000 });
  report.push("PASS: fast SQL reply is visibly identified");
  await page.getByRole("textbox", { name: "Câu hỏi", exact: true }).fill("Phân tích toàn bộ camera tuần trước, tìm bất thường và lập báo cáo");
  await page.getByRole("button", { name: "Gửi", exact: true }).click();
  await page.getByText("Gateway dự phòng · kết quả giới hạn", { exact: true }).first().waitFor({ timeout: 25000 });
  report.push("PASS: unconfigured Hermes clearly returns limited fallback");
  await page.screenshot({ path: "artifacts/screenshots/chat-fallback-desktop.png", fullPage: true });

  await page.goto(base + "/memory");
  await page.getByRole("textbox", { name: "Tìm kiếm thông minh", exact: true }).fill("Phân tích toàn bộ camera tuần trước, tìm bất thường và lập báo cáo");
  await page.getByRole("button", { name: "Tìm", exact: true }).click();
  await page.getByText("Gateway dự phòng · chỉ tổng hợp dữ liệu đã lưu", { exact: true }).waitFor({ timeout: 25000 });
  report.push("PASS: Memory smart search handles asynchronous report jobs without a response-shape error");

  const services = await context.request.get(base + "/api/orchestration");
  const serviceConfig = await services.json();
  const hasVision = serviceConfig.services.some((s: { name: string; configured: boolean }) => s.name === "vision" && s.configured);
  if (!hasVision) {
    const fixture = await sharp(randomBytes(160 * 100 * 3), { raw: { width: 160, height: 100, channels: 3 } }).png().toBuffer();
    await page.goto(base + "/extract");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "browser-contract-fixture.png", mimeType: "image/png", buffer: fixture });
    await page.getByText(/Asset #/).waitFor();
    await page.getByRole("textbox", { name: "Ghi chú yêu cầu", exact: true }).fill("Đếm hộp trong ảnh kiểm tra giao diện");
    await page.getByRole("button", { name: /Lưu ghi chú · không cần AI/ }).click();
    await page.getByText("Đã lưu ghi chú · chưa chạy AI", { exact: true }).waitFor();
    report.push("PASS: image upload + direct note save work without AI");
    await page.getByRole("button", { name: "Trích xuất", exact: true }).click();
    await page.getByText("Không hoàn tất", { exact: true }).waitFor({ timeout: 25000 });
    await page.getByText(/Ảnh và ghi chú|Ghi chú và ảnh gốc|Không có worker xử lý ảnh/).first().waitFor();
    await page.screenshot({ path: "artifacts/screenshots/extract-no-worker-desktop.png", fullPage: true });
    report.push("PASS: missing worker produces actionable error, not a fabricated extraction");
  } else report.push("SKIP: missing-worker scenario because a real Vision endpoint is configured");

  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
  if (heavyDownloads.length) throw new Error(`Unexpected model downloads: ${heavyDownloads.join(", ")}`);
  report.push("PASS: no uncaught browser errors; no TensorFlow/Tesseract/model downloads");
  console.log(report.join("\n"));
} finally {
  await context.close(); await browser.close();
  await Promise.allSettled(pendingResponses);
  if (userId) {
    await db.delete(aiJobs).where(eq(aiJobs.userId, userId));
    await db.delete(messages).where(eq(messages.userId, userId));
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(extractions).where(eq(extractions.createdBy, name));
    if (assetIds.size) await db.delete(assets).where(inArray(assets.id, [...assetIds]));
    await db.delete(auditLog).where(or(eq(auditLog.actor, name), and(eq(auditLog.targetType, "user"), eq(auditLog.targetId, String(userId)))));
    await db.delete(users).where(eq(users.id, userId));
  }
  await pool.end();
}

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
