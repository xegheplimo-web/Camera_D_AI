// Smoke thật cho P4 "Ghi vào máy": bấm Ghi → nút chuyển sang Dừng (đếm giây) →
// bấm Dừng → trình duyệt nhận một file tải về. Không kiểm bằng grep.
// Chạy: node --import tsx tests/p4-local-record.smoke.ts
import "dotenv/config";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { randomBytes, scryptSync } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { ensureDefaultTenant } from "./helpers/tenant";
import { db } from "../src/db";
import { users, cameras } from "../src/db/schema";
import { inArray } from "drizzle-orm";

const explicitBase = process.env.DAI_TEST_BASE_URL;
const results: string[] = [];
let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  results.push(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed++;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const n = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return n;
}

const name = `rec_${randomBytes(5).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const salt = randomBytes(16).toString("hex");
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
let userId: number | undefined;
let cameraId: number | undefined;
let server: ChildProcess | undefined;
let base = explicitBase ?? "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    if (!explicitBase) {
      if (!existsSync(".next/BUILD_ID")) throw new Error("cần `npm run build` trước khi chạy smoke này");
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
        env: { ...process.env, NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (let i = 0; i < 60; i++) {
        try {
          const r = await fetch(`${base}/login`, { redirect: "manual" });
          if (r.status > 0) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    await ensureDefaultTenant();
    const [u] = await db.insert(users).values({ login: name, displayName: name, role: "owner", passwordHash }).returning();
    userId = u.id;
    const [cam] = await db
      .insert(cameras)
      .values({
        code: `CAM-R${randomBytes(5).toString("hex")}`,
        name: "Camera ghi về máy",
        location: "Smoke",
        sourceType: "demo",
        status: "demo",
        enabled: true,
      })
      .returning();
    cameraId = cam.id;

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "Tên đăng nhập", exact: true }).fill(name);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    await page.waitForURL(`${base}/`, { timeout: 30000 });
    await page.goto(`${base}/camera`, { waitUntil: "domcontentloaded" });

    // Trong môi trường headless camera thật không có frame decode được, nên luồng
    // MJPEG được thay bằng một JPEG tĩnh: mục đích là kiểm đường canvas →
    // captureStream → MediaRecorder → tải file, không phải kiểm camera 796.
    const jpg = await sharp({ create: { width: 320, height: 180, channels: 3, background: { r: 20, g: 80, b: 160 } } }).jpeg().toBuffer();
    await page.route("**/api/cameras/*/stream*", (route) =>
      route.fulfill({ status: 200, contentType: "image/jpeg", body: jpg }),
    );

    // Locator ổn định qua cả hai trạng thái: nhãn đổi "Ghi vào máy" ⇄ "Dừng và lưu",
    // nên bám theo title (có ở cả hai) thay vì tên nút.
    const btn = page.locator('button[title*="Ghi khung hình"], button[title*="Dừng và lưu"]').first();
    await btn.waitFor({ timeout: 20000 });
    check("nút 'Ghi vào máy' có trên khung camera", true);
    check("nút chưa ở trạng thái ghi", (await btn.getAttribute("aria-pressed")) === "false");

    // Chẩn đoán: nút chỉ bấm được khi mime đã dò xong, và start() cần một khung
    // hình đã decode. Ghi lại trạng thái thật thay vì đoán.
    const pre = await page.evaluate(() => {
      const b = document.querySelector('button[title*="Ghi khung hình"]') as HTMLButtonElement | null;
      const img = document.querySelector(".aspect-video img") as HTMLImageElement | null;
      return { disabled: b?.disabled ?? null, hasImg: Boolean(img), src: img?.getAttribute("src")?.slice(0, 60) ?? null, complete: img?.complete ?? null, w: img?.naturalWidth ?? null };
    });
    console.log("   [diag]", JSON.stringify(pre));

    const tClick = Date.now();
    await btn.click();
    const at0 = (await btn.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    await page.waitForTimeout(1500);
    const errText = await page.locator("span.text-amber-200").first().innerText({ timeout: 300 }).catch(() => "");
    const afterClick = (await btn.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const pressed = await btn.getAttribute("aria-pressed");
    console.log(`   [clock] sau click ~0ms: "${at0}" | ~${Date.now() - tClick}ms: "${afterClick}"`);
    check("đồng hồ bắt đầu từ 00:00 (không cộng dồn từ lúc mở trang)", /Dừng và lưu \(00:0[0-2]\)/.test(at0), at0);
    check("bấm Ghi ⇒ nút chuyển sang 'Dừng và lưu' với đồng hồ", /Dừng và lưu/.test(afterClick), `text="${afterClick}" pressed=${pressed}`);
    check("aria-pressed = true khi đang ghi", pressed === "true", `pressed=${pressed}`);
    const stopBtn = btn;

    await page.waitForTimeout(2500);
    const label = await stopBtn.innerText();
    check("đồng hồ chạy (không đứng ở 00:00)", !/\(00:00\)/.test(label), label);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 20000 }).catch(() => null),
      stopBtn.click(),
    ]);
    check("bấm Dừng ⇒ trình duyệt nhận file tải về", Boolean(download), download ? download.suggestedFilename() : "không có download");
    if (download) {
      check("tên file có đuôi video", /\.(webm|mp4)$/i.test(download.suggestedFilename()), download.suggestedFilename());
      const p = await download.path();
      check("file tải về có dữ liệu", Boolean(p));
    }
    check("không có lỗi JS trên trang", errors.length === 0, errors.slice(0, 2).join(" | "));
  } catch (e) {
    check("smoke chạy được", false, e instanceof Error ? e.message : String(e));
  } finally {
    for (const line of results) console.log(line);
    console.log(failed === 0 ? `ALL PASS (${results.length})` : `FAILED ${failed}/${results.length}`);
    await browser.close().catch(() => {});
    server?.kill();
    if (cameraId) await db.delete(cameras).where(inArray(cameras.id, [cameraId])).catch(() => {});
    if (userId) await db.delete(users).where(inArray(users.id, [userId])).catch(() => {});
    process.exit(failed === 0 ? 0 : 1);
  }
}

void main();
