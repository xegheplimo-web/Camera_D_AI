// Đo tràn ngang thật bằng Playwright ở nhiều bề rộng, cho cả trang chủ và /wall.
// Chạy: node --import tsx tests/responsive-layout.smoke.ts
// Nếu DAI_TEST_BASE_URL được set thì dùng server đó; nếu không thì tự start
// `next start` trên port trống để luôn kiểm đúng bundle vừa build.
//
// Nguyên tắc: KHÔNG dùng overflow-x:hidden để che lỗi. Test này fail khi
// document.scrollWidth > clientWidth — tức là có phần tử thật sự đẩy trang rộng ra.
import "dotenv/config";
import { chromium, type Page } from "@playwright/test";
import { randomBytes, scryptSync } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { ensureDefaultTenant } from "./helpers/tenant";
import { db } from "../src/db";
import { users, cameras } from "../src/db/schema";
import { inArray } from "drizzle-orm";

const explicitBase = process.env.DAI_TEST_BASE_URL;
const results: string[] = [];
let failed = 0;
function check(name: string, ok: boolean, extra = "") {
  const suffix = extra ? ` — ${extra}` : "";
  results.push(`${ok ? "PASS" : "FAIL"}: ${name}${suffix}`);
  if (!ok) failed++;
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const n = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return n;
}

const name = `resp_${randomBytes(5).toString("hex")}`;
const password = randomBytes(16).toString("hex");
const salt = randomBytes(16).toString("hex");
const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
let userId: number | undefined;
const cameraIds: number[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ChildProcess | undefined;
let base = explicitBase ?? "http://localhost:3000";

async function ensureServer(): Promise<void> {
  if (explicitBase) return;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/login`, { redirect: "manual" });
      if (r.status > 0) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("next start không lên trong 30s");
}

type Overflow = { over: number; wide: { tag: string; cls: string; right: number }[] };

/** Đo tràn ngang: chênh lệch scrollWidth-clientWidth + các phần tử vượt mép phải. */
async function measure(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const over = de.scrollWidth - de.clientWidth;
    const wide: { tag: string; cls: string; right: number }[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.right > window.innerWidth + 1) {
        wide.push({
          tag: el.tagName.toLowerCase(),
          cls: String((el as HTMLElement).className || "").slice(0, 80),
          right: Math.round(r.right),
        });
        if (wide.length >= 6) break;
      }
    }
    return { over, wide };
  });
}

// Bề rộng CSS hữu dụng tương ứng khi người dùng zoom trình duyệt trên màn 1920:
// 100% -> 1920, 125% -> 1536, 150% -> 1280. Đo trực tiếp theo bề rộng này là
// cách kiểm đúng bản chất (zoom làm giảm viewport CSS), ổn định hơn setPageScaleFactor.
const WIDTHS = [1920, 1536, 1440, 1366, 1280, 1024, 768, 375];

async function auditPage(page: Page, path: string, label: string) {
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    const m = await measure(page);
    const detail = m.over > 0 ? `over=${m.over}px ${JSON.stringify(m.wide.slice(0, 3))}` : "";
    check(`${label} @${w}px không tràn ngang`, m.over <= 0, detail);
  }
}

async function main() {
  try {
    await ensureServer();
    await ensureDefaultTenant();
    const [u] = await db.insert(users).values({ login: name, displayName: name, role: "owner", passwordHash }).returning();
    userId = u.id;

    // 10 camera demo: đủ để kiểm "danh sách không đẩy trang rộng ra" và wall 10 ô.
    for (let i = 0; i < 10; i++) {
      const [cam] = await db
        .insert(cameras)
        .values({
          code: `CAM-R${randomBytes(5).toString("hex")}`,
          name: `Camera responsive ${i + 1}`,
          location: "Responsive",
          sourceType: "demo",
          status: "demo",
          enabled: true,
        })
        .returning();
      cameraIds.push(cam.id);
    }
    check("tạo 10 camera demo", cameraIds.length === 10);

    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox", { name: "Tên đăng nhập", exact: true }).fill(name);
    await page.getByLabel("Mật khẩu", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Đăng nhập", exact: true }).click();
    await page.waitForURL(`${base}/`, { timeout: 30000 });

    await auditPage(page, "/", "trang chủ");
    await auditPage(page, "/wall", "tường camera");

    // Khung hình phải giữ 16:9 và không méo: đo tỉ lệ khung hiển thị.
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const ratio = await page.evaluate(() => {
      const vid = document.querySelector(".aspect-video") as HTMLElement | null;
      if (!vid) return null;
      const r = vid.getBoundingClientRect();
      return r.width > 0 ? +(r.width / r.height).toFixed(3) : null;
    });
    check("khung camera giữ tỉ lệ 16:9", ratio === null ? false : Math.abs(ratio - 16 / 9) < 0.06, `ratio=${ratio}`);
  } catch (e) {
    check("harness chạy được", false, e instanceof Error ? e.message : String(e));
  } finally {
    for (const line of results) console.log(line);
    console.log(failed === 0 ? `ALL PASS (${results.length})` : `FAILED ${failed}/${results.length}`);
    try { await browser?.close(); } catch {}
    server?.kill();
    if (cameraIds.length) await db.delete(cameras).where(inArray(cameras.id, cameraIds)).catch(() => {});
    if (userId) await db.delete(users).where(inArray(users.id, [userId])).catch(() => {});
    process.exit(failed === 0 ? 0 : 1);
  }
}

void main();
