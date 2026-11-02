import { db } from "@/db";
import { cameras, assets, events, extractions, users, alertRules, appSettings } from "@/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { startOfDayVN, addDays } from "./time";
import { scryptSync, randomBytes } from "crypto";

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

export async function ensureIdentitySeed() {
  const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(users);
  if (c > 0) return;
  const passwords = [process.env.ADMIN_PASSWORD, process.env.OPERATOR_PASSWORD, process.env.VIEWER_PASSWORD];
  if (passwords.some((v) => !v || v.length < 12) || new Set(passwords).size !== 3) {
    throw new Error("Phải thiết lập ADMIN_PASSWORD, OPERATOR_PASSWORD, VIEWER_PASSWORD riêng biệt (>=12 ký tự) trước khi khởi tạo.");
  }
  await db.insert(users).values([
    { login: "owner", displayName: "Chủ hệ thống", passwordHash: hashPassword(passwords[0]!), role: "owner" },
    { login: "operator", displayName: "Vận hành", passwordHash: hashPassword(passwords[1]!), role: "operator" },
    { login: "viewer", displayName: "Người xem", passwordHash: hashPassword(passwords[2]!), role: "viewer" },
  ]);
}

/**
 * Google-OAuth-only demo user (owner directive). NULL passwordHash means password
 * login can never succeed; google_sub is linked on first Google sign-in.
 * Idempotent on the users.login unique index.
 */
export async function ensureGoogleSeed() {
  await db
    .insert(users)
    .values({ login: "attong39@gmail.com", displayName: "attong39", passwordHash: null, role: "owner" })
    .onConflictDoNothing({ target: users.login });
}

export async function ensureSettingsSeed() {
  const [{ c }] = await db.select({ c: sql<number>`count(*)::int` }).from(appSettings);
  if (c > 0) return;
  await db.insert(appSettings).values([
    { key: "demoMode", value: demoSeedEnabled() },
    { key: "retentionDays", value: 30 },
    { key: "remotePlayback", value: false },
    { key: "requireVerifiedForAnswers", value: false },
    { key: "detectEnabled", value: false },
  ]);
}

/**
 * T-1305: dữ liệu mẫu chỉ được seed khi dev/demo chủ động bật CAMDAI_DEMO_SEED=1.
 * Cài mới mặc định demoMode=false và KHÔNG tạo topology demo (camera/sự kiện/trích xuất giả lập).
 * DB đã có demoMode=true từ trước không bị ghi đè — người dùng tắt tay trong Cài đặt.
 */
export function demoSeedEnabled() {
  return process.env.CAMDAI_DEMO_SEED === "1";
}

const CAMS = [
  { code: "CAM-01", name: "Camera 01", location: "Cửa ra vào", sourceType: "webcam", thumbnail: "/cams/cam1.jpg" },
  { code: "CAM-02", name: "Camera 02", location: "Sân / Bãi xe", sourceType: "demo", thumbnail: "/cams/cam2.jpg" },
  { code: "CAM-03", name: "Camera 03", location: "Trong nhà", sourceType: "demo", thumbnail: "/cams/cam3.jpg" },
  { code: "CAM-04", name: "Camera 04", location: "Kho / Khu vực B", sourceType: "demo", thumbnail: "/cams/cam4.jpg" },
];

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * T-1305b: marker bền "đã seed demo" trong app_settings (key-value có sẵn, không đổi schema).
 * ensureSeed chỉ bỏ qua phần demo khi marker đã có; reset_all xoá marker (qua reseed)
 * để seed lại được khi flag còn bật. Flag tắt → không seed, không ghi marker.
 */
export const DEMO_SEEDED_KEY = "demoSeeded";

type DbExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;

const DEMO_CAM_CODES = CAMS.map((c) => c.code);

/**
 * Dấu hiệu "demo đã seed": marker bền, hoặc topology demo còn sót (camera code
 * CAM-01..04 cố định của seed, event source='demo'). DB nâng cấp từ trước T-1305b
 * có topology demo nhưng chưa có marker → vẫn nhận ra, không seed trùng.
 * Camera mô phỏng user tự thêm (code CAM-<uuid>) và camera thật không phải dấu hiệu.
 */
export async function demoAlreadySeeded(executor: DbExecutor = db): Promise<boolean> {
  const [m] = await executor.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, DEMO_SEEDED_KEY));
  if (m) return true;
  const [d] = await executor.select({ c: sql<number>`count(*)::int` }).from(cameras).where(inArray(cameras.code, DEMO_CAM_CODES));
  if (d.c > 0) return true;
  const [e] = await executor.select({ c: sql<number>`count(*)::int` }).from(events).where(eq(events.source, "demo"));
  return e.c > 0;
}

/** Ghi marker sau khi seed demo thành công; idempotent qua PK app_settings.key. */
export async function markDemoSeeded(executor: DbExecutor = db) {
  // Cột jsonb nhận raw param: truyền "1" trần sẽ thành số 1 — serialize trước để lưu đúng chuỗi "1".
  await executor.insert(appSettings).values({ key: DEMO_SEEDED_KEY, value: JSON.stringify("1") }).onConflictDoNothing({ target: appSettings.key });
}

let seeding: Promise<boolean> | null = null;

/**
 * reset_all: quên latch + marker để ensureSeed đánh giá lại từ trạng thái DB hiện tại.
 * Trả true nếu lần chạy này seed được dữ liệu demo.
 */
export async function reseed() {
  seeding = null;
  await db.delete(appSettings).where(eq(appSettings.key, DEMO_SEEDED_KEY));
  return ensureSeed();
}

/** Trả true nếu lần chạy này seed được topology demo (flag bật + chưa có dấu hiệu demo). */
export async function ensureSeed(): Promise<boolean> {
  if (seeding) return seeding;
  seeding = (async () => {
    await ensureIdentitySeed();
    await ensureGoogleSeed();
    await ensureSettingsSeed();
    if (!demoSeedEnabled()) return false;
    if (await demoAlreadySeeded()) {
      // DB nâng cấp: topology demo có sẵn nhưng thiếu marker → ghi bù để lần sau chỉ tốn 1 lookup.
      await markDemoSeeded();
      return false;
    }

    const camRows = await db.insert(cameras).values(CAMS.map((c, i) => ({ ...c, status: i === 0 ? "demo" : "demo" }))).returning();
    await db.insert(alertRules).values([
      { name: "Người trong kho ngoài giờ", type: "alert", priority: "critical", cameraId: camRows[3].id, cooldownSeconds: 600, notifyPush: true },
      { name: "Phát hiện phương tiện lạ", type: "vehicle", priority: "important", cameraId: camRows[1].id, cooldownSeconds: 300 },
    ]);
    const assetRows = await db
      .insert(assets)
      .values(
        camRows.map((cam) => ({
          kind: "image",
          mime: "image/jpeg",
          sha256: `demo-${cam.code}`,
          url: cam.thumbnail,
          origin: "demo",
          cameraId: cam.id,
        }))
      )
      .returning();
    const assetFor = (camId: number) => assetRows.find((a) => a.cameraId === camId)!.id;

    const rand = rng(42);
    const now = new Date();
    const today = startOfDayVN(now);
    const rows: (typeof events.$inferInsert)[] = [];
    // hourly traffic profile (VN local hour -> weight)
    const profile: Record<number, number> = { 7: 1, 8: 2, 9: 3, 10: 5, 11: 4, 12: 2, 13: 2, 14: 3, 15: 3, 16: 4, 17: 5, 18: 4, 19: 3, 20: 1 };
    let track = 1;
    const nowHourVN = new Date(now.getTime() + 7 * 3600000).getUTCHours();
    for (let d = 13; d >= 0; d--) {
      const day = addDays(today, -d);
      // For today, map the business-hours profile onto the hours already elapsed so the demo is never empty.
      const shift = d === 0 && nowHourVN < 20 ? Math.max(-7, nowHourVN - 20) : 0;
      for (let h = 7; h <= 20; h++) {
        const n = Math.round((profile[h] ?? 0) * (0.6 + rand() * 0.8));
        const hh = h + shift;
        if (hh < 0) continue;
        for (let i = 0; i < n; i++) {
          const at = new Date(day.getTime() + hh * 3600000 + Math.floor(rand() * 3600000));
          if (at > now) continue;
          const cam1 = camRows[0].id;
          rows.push({
            cameraId: cam1, type: "person_in", objectClass: "person",
            label: `Khách vào (ID: ${String(track).padStart(3, "0")})`, trackId: `demo-${track}`,
            confidence: 0.86 + rand() * 0.13, assetId: assetFor(cam1), tags: ["khách"], source: "demo", happenedAt: at,
          });
          const out = new Date(at.getTime() + (8 + rand() * 50) * 60000);
          if (out < now && rand() > 0.15) {
            rows.push({
              cameraId: cam1, type: "person_out", objectClass: "person",
              label: `Khách ra (ID: ${String(track).padStart(3, "0")})`, trackId: `demo-${track}`,
              confidence: 0.84 + rand() * 0.14, assetId: assetFor(cam1), tags: ["khách"], source: "demo", happenedAt: out,
            });
          }
          track++;
        }
        // vehicles at parking lot
        const v = Math.round((profile[h] ?? 0) * 0.5 * rand());
        for (let i = 0; i < v; i++) {
          const at = new Date(day.getTime() + hh * 3600000 + Math.floor(rand() * 3600000));
          if (at > now) continue;
          const moto = rand() > 0.35;
          const cam2 = camRows[1].id;
          rows.push({
            cameraId: cam2, type: "vehicle", objectClass: moto ? "motorcycle" : "car",
            label: moto ? "Phát hiện xe máy vào bãi" : "Phát hiện ô tô vào bãi",
            confidence: 0.8 + rand() * 0.18, assetId: assetFor(cam2), tags: ["phương tiện", moto ? "xe máy" : "ô tô"], source: "demo", happenedAt: at,
          });
        }
        if (rand() > 0.82) {
          const at = new Date(day.getTime() + hh * 3600000 + Math.floor(rand() * 3600000));
          if (at <= now) {
            const cam4 = camRows[3].id;
            rows.push({
              cameraId: cam4, type: "motion", objectClass: "person",
              label: "Có người di chuyển trong khu vực kho", confidence: 0.78 + rand() * 0.15,
              assetId: assetFor(cam4), tags: ["hoạt động", "kho"], source: "demo", happenedAt: at,
            });
          }
        }
      }
      if (d % 4 === 1) {
        const at = new Date(day.getTime() + 22 * 3600000 + Math.floor(rand() * 3600000));
        if (at <= now)
          rows.push({
            cameraId: camRows[3].id, type: "alert", objectClass: "person", priority: "critical",
            label: "Cảnh báo: phát hiện người trong kho ngoài giờ", confidence: 0.82,
            assetId: assetFor(camRows[3].id), tags: ["cảnh báo", "ngoài giờ"], source: "demo", happenedAt: at,
          });
      }
    }
    for (let i = 0; i < rows.length; i += 500) await db.insert(events).values(rows.slice(i, i + 500));

    await db.insert(extractions).values({
      assetId: assetFor(camRows[3].id),
      title: "Kiểm kê kho khu B",
      note: "Đếm thùng carton và thùng nhựa xanh trên kệ, ghi chú vị trí.",
      taskType: "object_count",
      status: "VERIFIED",
      memoryType: "verified",
      tags: ["kho", "kiểm kê"],
      source: "demo",
      verifiedAt: addDays(now, -1),
      createdAt: addDays(now, -1),
      result: {
        summary: "Khu B có các kệ chứa thùng carton và thùng nhựa xanh (số liệu đã được người dùng xác minh).",
        details: ["Kệ trái: thùng carton xếp 3 tầng", "Kệ phải: thùng nhựa xanh"],
        objects: [
          { label: "thùng carton", count: 18, confidence: 1 },
          { label: "thùng nhựa xanh", count: 6, confidence: 1 },
        ],
        ocrText: "",
        structured: [{ key: "Khu vực", value: "Kho B", confidence: 1 }],
        confidence: 1,
        warnings: [],
        engine: ["human-verified"],
      },
    });
    await markDemoSeeded();
    return true;
  })().catch((e) => {
    seeding = null;
    throw e;
  });
  return seeding;
}
