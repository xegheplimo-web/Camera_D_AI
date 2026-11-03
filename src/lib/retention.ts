/**
 * Vòng đời dữ liệu (REAL-003): retention có hiệu lực + purge dữ liệu demo.
 *
 * runRetention(): xoá events/extractions quá app_settings.retentionDays ngày
 * (đọc lại mỗi lần chạy; <=0 → no-op), sau đó xoá assets quá hạn không còn
 * tham chiếu — kèm file local: nếu app quản lý (chỉ dưới dataDir(), đã chống
 * traversal trong localAssetPath). events tôn trọng cameras.retention_days
 * (NULL/0 → global, >0 → override số ngày giữ của riêng camera).
 *
 * purgeDemoData(): xoá toàn bộ dữ liệu mẫu theo thứ tự FK an toàn
 * extractions → events → assets; KHÔNG đụng hàng source<>'demo'. Con trỏ
 * asset_id/event_id của hàng live vào dữ liệu demo bị gỡ về NULL thay vì
 * để dangling — hàng live tự thân được giữ nguyên.
 *
 * Cả hai hàm nhận `executor` mặc định là pool db; truyền transaction để
 * rollback trong test hoặc gom atomic với caller. Mỗi hàm ghi đúng 1 dòng
 * audit_log qua cùng executor nên test rollback sạch.
 */
import { rm } from "node:fs/promises";
import { and, eq, inArray, lt, not, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, assets, auditLog, events, extractions } from "@/db/schema";
import { localAssetPath } from "@/lib/camera/detector";

export type DbExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete" | "execute">;
export type AuditActor = { name?: string | null; role?: string | null; device?: string | null };

/** Mốc thời gian cắt: bản ghi cũ hơn now - days ngày bị xem là hết hạn. */
export function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/** Asset không còn được bất kỳ event/extraction nào tham chiếu. */
const ORPHAN_ASSET = sql`${assets.id} not in (select asset_id from events where asset_id is not null)
  and ${assets.id} not in (select asset_id from extractions where asset_id is not null)`;

/** Xoá file local: do app quản lý; chỉ path hợp lệ dưới dataDir() (chặn traversal). */
async function removeAssetFile(url: string | null): Promise<boolean> {
  const path = localAssetPath(url);
  if (!path) return false;
  await rm(path, { force: true }).catch(() => {});
  return true;
}

export type RetentionReport = {
  /** File cần xoá SAU khi transaction commit (two-phase: DB trước, đĩa sau). */
  pendingFiles: string[];
  retentionDays: number;
  cutoff: string | null;
  events: number;
  extractions: number;
  assets: number;
  bytes: number;
};

export async function runRetention(executor: DbExecutor = db): Promise<RetentionReport> {
  // Đọc qua executor để test trong transaction thấy giá trị vừa set.
  const [row] = await executor.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "retentionDays"));
  const days = typeof row?.value === "number" && Number.isFinite(row.value) ? row.value : 30;
  if (days <= 0) return { retentionDays: days, cutoff: null, events: 0, extractions: 0, assets: 0, bytes: 0, pendingFiles: [] };
  const cutoff = retentionCutoff(new Date(), days);

  // 1. Extractions hết hạn (lá của đồ thị tham chiếu — không bảng nào trỏ tới).
  const delEx = await executor.delete(extractions).where(lt(extractions.createdAt, cutoff)).returning({ id: extractions.id });

  // 2. Events hết hạn; camera có retention_days>0 dùng override của nó.
  const delEv = await executor.delete(events).where(sql`${events.happenedAt} < now() - (coalesce(
      (select c.retention_days from cameras c where c.id = ${events.cameraId} and c.retention_days > 0),
      ${days}
    )::int * interval '1 day')`).returning({ id: events.id });

  // 3. Gỡ con trỏ event_id còn sống sót trỏ vào event đã xoá (kể cả dangling có sẵn).
  await executor.execute(sql`update extractions set event_id = null
    where event_id is not null and event_id not in (select id from events)`);

  // 4. Assets quá hạn và không còn tham chiếu → xoá file local rồi xoá hàng.
  const orphans = await executor
    .select({ id: assets.id, url: assets.url, sizeBytes: assets.sizeBytes })
    .from(assets)
    .where(and(lt(assets.createdAt, cutoff), ORPHAN_ASSET));
  let bytes = 0;
  const pendingFiles: string[] = [];
  for (const a of orphans) {
    bytes += a.sizeBytes ?? 0;
    // KHÔNG xoá file ở đây: transaction có thể rollback → mất file nhưng hàng còn.
    if (a.url) pendingFiles.push(a.url);
  }
  if (orphans.length) {
    await executor.delete(assets).where(inArray(assets.id, orphans.map((a) => a.id)));
  }

  const report: RetentionReport = {
    retentionDays: days,
    cutoff: cutoff.toISOString(),
    events: delEv.length,
    extractions: delEx.length,
    assets: orphans.length,
    bytes,
    pendingFiles,
  };
  await executor.insert(auditLog).values({
    actor: "system",
    action: "data.retention",
    targetType: "events|extractions|assets",
    detail: `cutoff=${report.cutoff} events=${report.events} extractions=${report.extractions} assets=${report.assets} bytes=${report.bytes}`,
  });
  return report;
}

export type PurgeReport = { extractions: number; events: number; assets: number; assetsKept: number; bytes: number; pendingFiles: string[] };

export async function purgeDemoData(executor: DbExecutor = db, actor: AuditActor = {}): Promise<PurgeReport> {
  // FK-safe: extractions và events là phía tham chiếu → xoá trước; assets sau.
  const delEx = await executor.delete(extractions).where(eq(extractions.source, "demo")).returning({ id: extractions.id });
  const delEv = await executor.delete(events).where(eq(events.source, "demo")).returning({ id: events.id });

  // Hàng live trỏ vào asset demo: events.asset_id nullable → gỡ về NULL (hàng live giữ nguyên).
  await executor.execute(sql`update events set asset_id = null
    where asset_id is not null and asset_id in (select id from assets where origin = 'demo')`);
  // extractions.asset_id NOT NULL → không thể gỡ: asset demo còn được live extraction
  // tham chiếu phải giữ lại, báo trong assetsKept.
  const [tot] = await executor.select({ c: sql<number>`count(*)::int` }).from(assets).where(eq(assets.origin, "demo"));
  const demoAssets = await executor
    .select({ id: assets.id, url: assets.url, sizeBytes: assets.sizeBytes })
    .from(assets)
    .where(and(eq(assets.origin, "demo"), not(sql`${assets.id} in (select asset_id from extractions where asset_id is not null)`)));
  let bytes = 0;
  const pendingFiles: string[] = [];
  for (const a of demoAssets) {
    bytes += a.sizeBytes ?? 0;
    if (a.url) pendingFiles.push(a.url); // xoá sau commit, xem unlinkPending()
  }
  if (demoAssets.length) {
    await executor.delete(assets).where(inArray(assets.id, demoAssets.map((a) => a.id)));
  }

  const report: PurgeReport = { extractions: delEx.length, events: delEv.length, assets: demoAssets.length, assetsKept: tot.c - demoAssets.length, bytes, pendingFiles };
  await executor.insert(auditLog).values({
    actor: actor.name ?? null,
    actorRole: actor.role ?? null,
    device: actor.device ?? null,
    action: "data.purge_demo",
    targetType: "events|extractions|assets",
    detail: `events=${report.events} extractions=${report.extractions} assets=${report.assets} kept=${report.assetsKept} bytes=${report.bytes}`,
  });
  return report;
}

/* ---------------- lập lịch nền ---------------- */

const DAY_MS = 24 * 3_600_000;

function intervalMs(): number {
  const parsed = Number(process.env.RETENTION_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DAY_MS;
}

const globalForRetention = globalThis as typeof globalThis & {
  __daiRetention?: { started: boolean; timer: ReturnType<typeof setInterval> | null };
};
const state = (globalForRetention.__daiRetention ??= { started: false, timer: null });

/**
 * Xoá file sau khi transaction đã commit. Best-effort: nếu unlink lỗi thì chỉ
 * còn file mồ côi trên đĩa (an toàn), không bao giờ mất dữ liệu còn tham chiếu.
 */
export async function unlinkPending(files: string[]): Promise<{ removed: number; failed: number }> {
  let removed = 0, failed = 0;
  for (const url of files) {
    if (await removeAssetFile(url)) removed++;
    else failed++;
  }
  return { removed, failed };
}

async function runSafe() {
  try {
    // Atomic: mọi xoá + audit row commit cùng nhau, hoặc rollback hết.
    const report = await db.transaction(async (tx) => runRetention(tx));
    const { failed } = await unlinkPending(report.pendingFiles);
    if (failed) console.warn(`[retention] ${failed} file không xoá được — để lại đĩa, sẽ dọn lần sau`);
  } catch (e) {
    console.error("[retention]", e instanceof Error ? e.message : e);
  }
}

/** Gọi một lần từ instrumentation register(): chạy ngay 1 lần + lặp theo chu kỳ (mặc định 24h). */
export function startRetention(): void {
  if (state.started) return;
  state.started = true;
  void runSafe();
  state.timer = setInterval(() => void runSafe(), intervalMs());
  state.timer.unref?.();
}
