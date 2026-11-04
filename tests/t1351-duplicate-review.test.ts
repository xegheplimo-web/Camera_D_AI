import "dotenv/config";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { freePort, loginUser, makeCall, wait, type Call } from "./helpers/http";
import { ensureDefaultTenant } from "./helpers/tenant";
import { cleanupKnowledgeItems, mkAsset, mkKnowledgeItem } from "./helpers/knowledge";
import { db, pool } from "../src/db";
import {
  assets,
  auditLog,
  knowledgeImages,
  knowledgeItems,
  knowledgeMergeLog,
  knowledgePriceHistory,
  sessions,
  tenants,
  users,
} from "../src/db/schema";

/**
 * T-1351 — phủ UI + route "Rà soát trùng" trên `next start` thật (build .next).
 * Fixture item/ảnh/giá ghi thẳng DB (đã phủ ở t1335/t1355/t1356); mọi hành vi
 * của tính năng đi qua HTTP đúng như UI gọi:
 *   GET /knowledge/duplicates · GET /api/knowledge/duplicates/pairs
 *   GET /api/knowledge/merge/preview · POST /api/knowledge/merge
 *   POST /api/knowledge/merge/undo · POST /api/knowledge/duplicates/keep-separate
 * Chứng minh: gộp không xoá dữ liệu; khác giá không tự chọn (phải priceChoice);
 * hoàn tác 24 h khôi phục đúng; "giữ riêng" ẩn cặp; viewer không thấy nút thao
 * tác (SSR gate + API ghi 403); cách ly tenant.
 */

const prefix = `t1351_${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
let app: ChildProcess, base: string;
const call: Call = makeCall(() => base);
const cookies: Record<string, string> = {};
const userIds: number[] = [];
const itemIds: number[] = [];
const assetIds: number[] = [];
let t2id = 0;
let itemsBefore = 0;
let logs = "";

const owner = () => cookies.owner;
const operator = () => cookies.operator;
const viewer = () => cookies.viewer;
const t2owner = () => cookies.t2owner;

/** EAN-13 hợp lệ (đúng checksum) — mỗi ca test một GTIN riêng để cặp không đụng nhau. */
function gtin(n: number): string {
  const body = `8938505${String(n).padStart(5, "0")}`; // 12 chữ số đầu
  const sum = body.split("").reverse().reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return body + String((10 - (sum % 10)) % 10);
}

const pairKeyOf = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

async function mkItem(tenantId: number, patch: Record<string, unknown>): Promise<number> {
  const id = await mkKnowledgeItem(tenantId, patch);
  itemIds.push(id);
  return id;
}

async function mkImg(tenantId: number, itemId: number, assetId: number): Promise<void> {
  await db.insert(knowledgeImages).values({ tenantId, itemId, assetId });
}

async function mkHist(tenantId: number, itemId: number, priceVnd: number, extra: Record<string, unknown> = {}): Promise<void> {
  await db.insert(knowledgePriceHistory).values({ tenantId, itemId, priceVnd, ...extra });
}

async function mkAst(tenantId: number, tag: string): Promise<number> {
  const id = await mkAsset(tenantId, `${prefix}-${tag}`);
  assetIds.push(id);
  return id;
}

/** HTML trang (makeCall cắt text 300 ký tự — trang cần full body). */
async function getPage(path: string, cookie = "") {
  const r = await fetch(base + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
  return { status: r.status, html: await r.text(), location: r.headers.get("location") };
}

const liveImages = (itemId: number) =>
  db
    .select({ id: knowledgeImages.id, assetId: knowledgeImages.assetId })
    .from(knowledgeImages)
    .where(and(eq(knowledgeImages.itemId, itemId), isNull(knowledgeImages.deletedAt)));

const histRows = (itemId: number) =>
  db.select({ id: knowledgePriceHistory.id }).from(knowledgePriceHistory).where(eq(knowledgePriceHistory.itemId, itemId));

const itemRow = (itemId: number) =>
  db
    .select({ merged: knowledgeItems.mergedIntoId, price: knowledgeItems.priceVnd })
    .from(knowledgeItems)
    .where(eq(knowledgeItems.id, itemId))
    .then((r) => r[0]);

before(async () => {
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
  await ensureDefaultTenant();
  const [t2] = await db.insert(tenants).values({ slug: `${prefix}-t2`, name: `${prefix} tenant 2` }).returning();
  t2id = t2.id;
  const inserted = await db
    .insert(users)
    .values([
      { login: `${prefix}_owner`, displayName: `${prefix}_owner`, role: "owner", passwordHash },
      { login: `${prefix}_operator`, displayName: `${prefix}_operator`, role: "operator", passwordHash },
      { login: `${prefix}_viewer`, displayName: `${prefix}_viewer`, role: "viewer", passwordHash },
      { login: `${prefix}_t2owner`, displayName: `${prefix}_t2owner`, role: "owner", passwordHash, tenantId: t2id },
    ])
    .returning();
  userIds.push(...inserted.map((u) => u.id));
  itemsBefore = (await db.select({ c: sql<number>`count(*)::int` }).from(knowledgeItems))[0].c;

  const appPort = await freePort();
  base = `http://localhost:${appPort}`;
  app = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(appPort)], {
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout?.on("data", (s) => {
    logs = (logs + s).slice(-10000);
  });
  app.stderr?.on("data", (s) => {
    logs = (logs + s).slice(-10000);
  });
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
  for (const who of ["owner", "operator", "viewer", "t2owner"]) cookies[who] = await loginUser(call, prefix, password, who);
}, { timeout: 60000 });

after(async () => {
  if (app && app.exitCode === null) {
    app.kill("SIGTERM");
    await Promise.race([new Promise((r) => app.once("exit", r)), wait(5000)]);
    if (app.exitCode === null) app.kill("SIGKILL");
  }
  await cleanupKnowledgeItems(itemIds); // items + images + price history + merge log + pair decisions
  if (assetIds.length) await db.delete(assets).where(inArray(assets.id, assetIds));
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await db.delete(auditLog).where(like(auditLog.actor, `${prefix}%`));
  if (t2id) await db.delete(tenants).where(eq(tenants.id, t2id));
  const itemsAfter = (await db.select({ c: sql<number>`count(*)::int` }).from(knowledgeItems))[0].c;
  assert.equal(itemsAfter, itemsBefore, "không được rò rỉ dòng knowledge_items sau suite");
  await pool.end();
}, { timeout: 20000 });

/* ================= 0. Trang /knowledge/duplicates (UI SSR) ================= */

test("UI: owner thấy trang bình thường; viewer thấy cảnh báo quyền (nút thao tác không render); khách bị đá về login", async () => {
  const own = await getPage("/knowledge/duplicates", owner());
  assert.equal(own.status, 200);
  assert.ok(own.html.includes("Rà soát trùng"), "trang phải có tiêu đề");
  assert.ok(!own.html.includes("không đủ quyền"), "owner/operator không được thấy NoPermissionState");

  const view = await getPage("/knowledge/duplicates", viewer());
  assert.equal(view.status, 200);
  assert.ok(view.html.includes("Rà soát trùng"));
  assert.ok(
    view.html.includes("không đủ quyền"),
    "viewer phải thấy NoPermissionState ngay từ SSR — nút Xem trước/Gộp/Giữ riêng không render",
  );

  const guest = await getPage("/knowledge/duplicates");
  assert.ok([307, 308].includes(guest.status), `khách phải bị redirect, got ${guest.status}`);
  assert.ok((guest.location ?? "").includes("/login"), "redirect phải về /login");

  const filtered = await getPage("/knowledge/duplicates?cameraId=5", owner());
  assert.equal(filtered.status, 200);
  assert.ok(filtered.html.includes("Đang lọc theo camera #5"), "cameraId trong query phải chảy vào UI");
});

/* ================= 1. Route pairs: auth + cặp hiện đúng ================= */

test("pairs: khách 401; viewer đọc được; cặp cùng GTIN hiện với đủ counts", async () => {
  const g = gtin(1);
  const a = await mkItem(1, { title: `${prefix} sữa A`, custom: { gtin: g } });
  const b = await mkItem(1, { title: `${prefix} sữa B`, custom: { gtin: g } });

  assert.equal((await call("/api/knowledge/duplicates/pairs", "GET", undefined, "")).status, 401);

  const r = await call("/api/knowledge/duplicates/pairs", "GET", undefined, owner());
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const hit = r.data.pairs.find((p: { key: string }) => p.key === pairKeyOf(a, b));
  assert.ok(hit, "cặp trùng phải xuất hiện trong pairs");
  assert.equal(hit.class, "EXACT_CANDIDATE");
  assert.equal(hit.priceConflict, false);
  for (const k of ["exact", "review", "variantsHidden", "decidedHidden"])
    assert.equal(typeof r.data.counts[k], "number", `counts.${k} phải là số`);

  assert.equal((await call("/api/knowledge/duplicates/pairs", "GET", undefined, viewer())).status, 200, "viewer đọc được (read)");
});

/* ================= 2. Gộp cơ bản — không xoá dữ liệu ================= */

test("gộp: preview ok → chuyển ảnh/lịch sử giá sang đích, ảnh trùng bỏ qua, merge log ghi đủ, cặp hết hiện", async () => {
  const g = gtin(2);
  const src = await mkItem(1, { title: `${prefix} gộp nguồn`, priceVnd: 50000, custom: { gtin: g, flavor: "ít đường" } });
  const tgt = await mkItem(1, { title: `${prefix} gộp đích`, priceVnd: 50000, custom: { gtin: g } });
  const aShared = await mkAst(1, "shared");
  const aSrc = await mkAst(1, "src-only");
  const aTgt = await mkAst(1, "tgt-only");
  await mkImg(1, src, aSrc);
  await mkImg(1, src, aShared);
  await mkImg(1, tgt, aShared);
  await mkImg(1, tgt, aTgt);
  await mkHist(1, src, 49000, { priceSource: "ocr" });
  await mkHist(1, tgt, 50000);

  const before = await call("/api/knowledge/duplicates/pairs", "GET", undefined, owner());
  assert.ok(before.data.pairs.some((p: { key: string }) => p.key === pairKeyOf(src, tgt)), "cặp phải hiện trước khi gộp");

  const pv = await call(`/api/knowledge/merge/preview?sourceId=${src}&targetId=${tgt}`, "GET", undefined, owner());
  assert.equal(pv.status, 200);
  assert.equal(pv.data.ok, true, JSON.stringify(pv.data));
  assert.deepEqual(pv.data.counts, { images: 2, duplicateImages: 1, priceHistory: 1 });

  const m = await call("/api/knowledge/merge", "POST", { sourceId: src, targetId: tgt }, operator());
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal(m.data.ok, true);
  assert.equal(m.data.movedImages, 1, "1 ảnh riêng của nguồn chuyển sang đích");
  assert.equal(m.data.skippedDuplicateImages, 1, "1 ảnh trùng asset bị bỏ qua");
  assert.equal(m.data.movedPriceHistory, 1);
  assert.equal(m.data.priceKept, 50000);
  assert.ok(m.data.logId > 0);

  // Không xoá dữ liệu: nguồn chỉ bị đánh dấu; đích nhận đủ; ảnh trùng xoá MỀM.
  assert.equal((await liveImages(src)).length, 0, "nguồn không còn ảnh sống");
  assert.equal((await histRows(src)).length, 0, "nguồn không còn lịch sử giá");
  const tgtImgs = await liveImages(tgt);
  assert.deepEqual(new Set(tgtImgs.map((i) => i.assetId)), new Set([aSrc, aShared, aTgt]), "đích giữ đủ 3 asset");
  assert.equal((await histRows(tgt)).length, 2, "đích nhận thêm 1 dòng lịch sử giá");
  assert.equal((await itemRow(src)).merged, tgt, "nguồn bị đánh dấu merged_into, KHÔNG bị xoá");

  const softDeleted = await db
    .select({ id: knowledgeImages.id })
    .from(knowledgeImages)
    .where(and(eq(knowledgeImages.itemId, src), sql`${knowledgeImages.deletedAt} is not null`));
  assert.equal(softDeleted.length, 1, "ảnh trùng của nguồn chỉ xoá mềm (giữ dấu vết để undo)");

  const [log] = await db.select().from(knowledgeMergeLog).where(eq(knowledgeMergeLog.id, m.data.logId));
  assert.ok(log, "knowledge_merge_log phải có bản ghi");
  assert.equal(Number(log.sourceId), src);
  assert.equal(Number(log.targetId), tgt);
  assert.equal(log.undoneAt, null);

  const afterPairs = await call("/api/knowledge/duplicates/pairs", "GET", undefined, owner());
  assert.ok(!afterPairs.data.pairs.some((p: { key: string }) => p.key === pairKeyOf(src, tgt)), "item đã gộp không còn tham gia rà soát");
});

/* ================= 3. Xung đột giá — không tự chọn ================= */

test("xung đột giá: preview PRICE_REVIEW_REQUIRED; gộp thiếu priceChoice bị 409; chọn source/target giữ đúng giá", async () => {
  const g = gtin(3);
  const src = await mkItem(1, { title: `${prefix} giá nguồn`, priceVnd: 12000, custom: { gtin: g } });
  const tgt = await mkItem(1, { title: `${prefix} giá đích`, priceVnd: 1200, custom: { gtin: g } });

  const pv = await call(`/api/knowledge/merge/preview?sourceId=${src}&targetId=${tgt}`, "GET", undefined, owner());
  assert.equal(pv.status, 200);
  assert.equal(pv.data.ok, false);
  assert.equal(pv.data.code, "PRICE_REVIEW_REQUIRED", "khác giá phải chặn và trả code yêu cầu người dùng chọn");
  assert.deepEqual(pv.data.prices, { source: 12000, target: 1200 });

  // KHÔNG tự chọn giá: thiếu priceChoice ⇒ từ chối 4xx, dữ liệu đứng yên.
  const refused = await call("/api/knowledge/merge", "POST", { sourceId: src, targetId: tgt }, owner());
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal((await itemRow(src)).merged, null, "bị từ chối thì không được đánh dấu gộp");
  assert.equal((await itemRow(tgt)).price, 1200, "giá đích không đổi khi gộp bị từ chối");

  const badChoice = await call("/api/knowledge/merge", "POST", { sourceId: src, targetId: tgt, priceChoice: "abc" }, owner());
  assert.equal(badChoice.status, 400);
  assert.equal(badChoice.data.detail, "INVALID_PRICE_CHOICE");

  // Người dùng chọn rõ ràng: source ⇒ đích nhận giá nguồn.
  const mSrc = await call("/api/knowledge/merge", "POST", { sourceId: src, targetId: tgt, priceChoice: "source" }, owner());
  assert.equal(mSrc.status, 200, JSON.stringify(mSrc.data));
  assert.equal(mSrc.data.priceKept, 12000);
  assert.equal((await itemRow(tgt)).price, 12000, "chọn source ⇒ giá đích = giá nguồn");

  // target ⇒ giữ giá đích.
  const g2 = gtin(4);
  const src2 = await mkItem(1, { title: `${prefix} giá C`, priceVnd: 30000, custom: { gtin: g2 } });
  const tgt2 = await mkItem(1, { title: `${prefix} giá D`, priceVnd: 8000, custom: { gtin: g2 } });
  const mTgt = await call("/api/knowledge/merge", "POST", { sourceId: src2, targetId: tgt2, priceChoice: "target" }, operator());
  assert.equal(mTgt.status, 200, JSON.stringify(mTgt.data));
  assert.equal(mTgt.data.priceKept, 8000);
  assert.equal((await itemRow(tgt2)).price, 8000, "chọn target ⇒ giữ giá đích");
});

/* ================= 4. Hoàn tác trong 24 h ================= */

test("hoàn tác: undo trả ảnh + lịch sử giá về nguồn; undo lần hai bị từ chối (không hoàn tác kép)", async () => {
  const g = gtin(5);
  const src = await mkItem(1, { title: `${prefix} undo nguồn`, priceVnd: 70000, custom: { gtin: g } });
  const tgt = await mkItem(1, { title: `${prefix} undo đích`, priceVnd: 70000, custom: { gtin: g } });
  const a = await mkAst(1, "undo");
  await mkImg(1, src, a);
  await mkHist(1, src, 69000);

  const m = await call("/api/knowledge/merge", "POST", { sourceId: src, targetId: tgt }, owner());
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.equal((await liveImages(src)).length, 0, "tiền đề: nguồn đã trống sau gộp");

  const u = await call("/api/knowledge/merge/undo", "POST", { logId: m.data.logId }, operator());
  assert.equal(u.status, 200, JSON.stringify(u.data));
  assert.equal(u.data.restoredImages, 1);
  assert.equal(u.data.restoredPriceHistory, 1);
  assert.equal(u.data.sourceId, src);
  assert.equal(u.data.targetId, tgt);

  assert.equal((await itemRow(src)).merged, null, "nguồn sống lại sau undo");
  assert.equal((await liveImages(src)).length, 1, "ảnh quay về nguồn");
  assert.equal((await liveImages(tgt)).length, 0, "đích trả lại ảnh");
  assert.equal((await histRows(src)).length, 1, "lịch sử giá quay về nguồn");

  const again = await call("/api/knowledge/merge/undo", "POST", { logId: m.data.logId }, owner());
  assert.equal(again.status, 409, "không được hoàn tác kép");
  assert.equal(again.data.detail, "ALREADY_UNDONE");

  assert.equal((await call("/api/knowledge/merge/undo", "POST", { logId: 99999999 }, owner())).status, 404, "logId lạ ⇒ 404");
});

/* ================= 5. Giữ riêng ================= */

test("giữ riêng: route ghi quyết định, cặp biến mất khỏi pairs, decidedHidden tăng ≥1", async () => {
  const g = gtin(6);
  const a = await mkItem(1, { title: `${prefix} giữ riêng A`, custom: { gtin: g, netQuantity: 500, netUnit: "ml" } });
  const b = await mkItem(1, { title: `${prefix} giữ riêng B`, custom: { gtin: g, netQuantity: 500, netUnit: "ml" } });

  const before = await call("/api/knowledge/duplicates/pairs", "GET", undefined, owner());
  assert.ok(before.data.pairs.some((p: { key: string }) => p.key === pairKeyOf(a, b)), "cặp phải hiện trước khi giữ riêng");
  const hiddenBefore = before.data.counts.decidedHidden;

  const k = await call("/api/knowledge/duplicates/keep-separate", "POST", { a, b }, operator());
  assert.equal(k.status, 200, JSON.stringify(k.data));
  assert.equal(k.data.ok, true);
  assert.equal(k.data.key, pairKeyOf(a, b));

  const after = await call("/api/knowledge/duplicates/pairs", "GET", undefined, owner());
  assert.ok(!after.data.pairs.some((p: { key: string }) => p.key === pairKeyOf(a, b)), "cặp đã quyết định phải biến mất");
  assert.ok(after.data.counts.decidedHidden >= hiddenBefore + 1, "decidedHidden phải tăng ít nhất 1");

  const empty = await call("/api/knowledge/duplicates/keep-separate", "POST", {}, owner());
  assert.equal(empty.status, 400);
  assert.equal(empty.data.detail, "INVALID_IDS");
});

/* ================= 6. Cách ly tenant ================= */

test("tenant: cặp chéo không xuất hiện; gộp/giữ-riêng chéo tenant bị từ chối cả hai chiều", async () => {
  const g = gtin(7);
  const t1 = await mkItem(1, { title: `${prefix} t1`, custom: { gtin: g } });
  const t2a = await mkItem(t2id, { title: `${prefix} t2a`, custom: { gtin: g } });
  const t2b = await mkItem(t2id, { title: `${prefix} t2b`, custom: { gtin: g } });

  const r1 = await call("/api/knowledge/duplicates/pairs", "GET", undefined, owner());
  assert.equal(r1.status, 200);
  const ids1 = new Set<number>(r1.data.pairs.flatMap((p: { a: { id: number }; b: { id: number } }) => [p.a.id, p.b.id]));
  assert.ok(!ids1.has(t2a) && !ids1.has(t2b), "item tenant 2 không được lọt vào pairs tenant 1");
  assert.ok(!r1.data.pairs.some((p: { key: string }) => p.key === pairKeyOf(t1, t2a)), "không được có cặp chéo tenant");

  const r2 = await call("/api/knowledge/duplicates/pairs", "GET", undefined, t2owner());
  assert.equal(r2.status, 200);
  assert.ok(r2.data.pairs.some((p: { key: string }) => p.key === pairKeyOf(t2a, t2b)), "tenant 2 thấy cặp của chính mình");
  assert.ok(!r2.data.pairs.some((p: { key: string }) => p.key === pairKeyOf(t1, t2a)), "tenant 2 cũng không thấy cặp chéo");

  const cross = await call("/api/knowledge/merge", "POST", { sourceId: t1, targetId: t2a }, owner());
  assert.equal(cross.status, 409, "gộp chéo tenant phải bị từ chối (4xx, không lộ sự tồn tại)");
  assert.equal(cross.data.detail, "NOT_FOUND");
  assert.equal((await itemRow(t1)).merged, null, "item t1 không bị đụng");
  assert.equal((await itemRow(t2a)).merged, null, "item t2 không bị đụng");

  const crossBack = await call("/api/knowledge/merge", "POST", { sourceId: t2a, targetId: t1 }, t2owner());
  assert.equal(crossBack.status, 409, "chiều ngược lại cũng bị từ chối");

  const crossKeep = await call("/api/knowledge/duplicates/keep-separate", "POST", { a: t1, b: t2a }, owner());
  assert.equal(crossKeep.status, 404, "keep-separate chéo tenant ⇒ 404");
});

/* ================= 7. Gate vai trò trên route ================= */

test("RBAC: viewer đọc được pairs/preview nhưng mọi ghi bị 403; khách 401; item nguyên vẹn", async () => {
  const g = gtin(8);
  const a = await mkItem(1, { title: `${prefix} rbac A`, priceVnd: 1000, custom: { gtin: g } });
  const b = await mkItem(1, { title: `${prefix} rbac B`, priceVnd: 1000, custom: { gtin: g } });

  assert.equal((await call(`/api/knowledge/merge/preview?sourceId=${a}&targetId=${b}`, "GET", undefined, viewer())).status, 200, "viewer vẫn xem trước được (read)");

  for (const r of [
    await call("/api/knowledge/merge", "POST", { sourceId: a, targetId: b }, viewer()),
    await call("/api/knowledge/merge/undo", "POST", { logId: 1 }, viewer()),
    await call("/api/knowledge/duplicates/keep-separate", "POST", { a, b }, viewer()),
  ])
    assert.equal(r.status, 403, `viewer ghi phải 403: ${JSON.stringify(r.data)}`);

  for (const r of [
    await call("/api/knowledge/merge", "POST", { sourceId: a, targetId: b }, ""),
    await call("/api/knowledge/duplicates/keep-separate", "POST", { a, b }, ""),
    await call("/api/knowledge/merge/undo", "POST", { logId: 1 }, ""),
  ])
    assert.equal(r.status, 401, `khách ghi phải 401: ${JSON.stringify(r.data)}`);

  assert.equal((await itemRow(a)).merged, null);
  assert.equal((await itemRow(b)).merged, null);
});
