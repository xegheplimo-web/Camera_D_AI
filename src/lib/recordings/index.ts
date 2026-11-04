/**
 * T-1323 — bản ghi video mediaMTX trên đĩa (server-only, không expose ra browser).
 *
 * mediaMTX ghi theo recordPath `…/recordings/%path/%Y-%m-%d_%H-%M-%S-%f.<ext>`
 * (ext = mp4|fmp4|m4s). %path là "cameraKey" — thư mục con ngay dưới
 * RECORDINGS_DIR. Timestamp trong TÊN FILE là giờ địa phương của máy mediaMTX
 * (không phải UTC) — parse bằng Date constructor local để khớp playback.
 *
 * Mọi đường dẫn đều resolve + kiểm tra nằm trong RECORDINGS_DIR; cameraKey chỉ
 * nhận [A-Za-z0-9._~-] một segment nên không thể thoát khỏi thư mục gốc (chặn
 * traversal kể cả khi caller truyền "../x"). Đĩa là nguồn sự thật chính cho
 * list/storage/purge — playback server (127.0.0.1:9996) có thể tắt.
 */
import { readdir, rm, rmdir, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, auditLog, cameraSettings, cameras } from "@/db/schema";
import { decryptSource } from "@/lib/camera/stream";

/* ---------------- cấu hình ---------------- */

const SEGMENT_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{1,6})\.(mp4|fmp4|m4s)$/i;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/;
const DAY_MS = 86_400_000;

export function recordingsDir(): string {
  return resolve(process.env.RECORDINGS_DIR || "F:/Camera-D-AI/runtime/recordings");
}

export function playbackBase(): string {
  return (process.env.MEDIAMTX_PLAYBACK ?? "http://127.0.0.1:9996").replace(/\/+$/, "");
}

/** Key hợp lệ = tên path mediaMTX an toàn: 1 segment, ký tự hạn chế, không "..". */
export function isCameraKey(v: string | null | undefined): v is string {
  return typeof v === "string" && KEY_RE.test(v) && !v.includes("..");
}

/** Camera-key → thư mục tuyệt đối trong root; null nếu key lạ/thoát root. */
function dirOf(root: string, key: string): string | null {
  if (!isCameraKey(key)) return null;
  const dir = resolve(root, key);
  const sep = process.platform === "win32" ? "\\" : "/";
  const a = process.platform === "win32" ? dir.toLowerCase() : dir;
  const b = process.platform === "win32" ? root.toLowerCase() : root;
  return a === b || a.startsWith(b + sep) ? dir : null;
}

/* ---------------- parser tên segment ---------------- */

export type ParsedSegmentName = { cameraKey: string | null; start: Date; file: string };

/**
 * Tách `%path/%Y-%m-%d_%H-%M-%S-%f.<ext>` → {cameraKey, start}. Chấp nhận path
 * tương đối "key/file", path tuyệt đối (cameraKey = tên thư mục cha), hoặc tên
 * file trần (cameraKey=null). Tên lạ/sai ngày → null, không throw.
 */
export function parseSegmentName(path: string): ParsedSegmentName | null {
  if (typeof path !== "string" || !path) return null;
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const file = parts.at(-1) ?? "";
  const m = SEGMENT_RE.exec(file);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, F] = m;
  const micros = Number(F.padEnd(6, "0")); // %f = microseconds; lùi về ms cho Date
  // Giờ địa phương của máy mediaMTX — trùng múi giờ với process Next trên cùng host.
  const start = new Date(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), Number(S), Math.floor(micros / 1000));
  if (
    start.getFullYear() !== Number(Y) || start.getMonth() !== Number(Mo) - 1 ||
    start.getDate() !== Number(D) || Number.isNaN(start.getTime())
  ) return null;
  const parent = parts.length >= 2 ? parts[parts.length - 2] : null;
  if (parent !== null && !isCameraKey(parent)) return null; // "../file" hoặc thư mục tên lạ → bỏ hẳn
  return { cameraKey: parent, start, file };
}

/* ---------------- đọc đĩa ---------------- */

export type RecordingSegment = {
  /** Path tương đối trong RECORDINGS_DIR, dạng "<key>/<file>" — định danh ổn định, không dùng làm URL. */
  file: string;
  cameraKey: string;
  start: Date;
  /** Ước tính từ gap tới segment kế hoặc mtime file; có thể thiếu. */
  durationSec?: number;
  sizeBytes: number;
};

async function dirKeys(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && isCameraKey(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

async function scanKeyDir(root: string, key: string): Promise<RecordingSegment[]> {
  const dir = dirOf(root, key);
  if (!dir) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const rows: { seg: RecordingSegment; mtimeMs: number }[] = [];
  for (const name of names) {
    const parsed = parseSegmentName(name);
    if (!parsed) continue;
    const st = await stat(join(dir, name)).catch(() => null);
    if (!st?.isFile() || st.size <= 0) continue; // bỏ file 0 byte + thư mục con
    rows.push({
      seg: { file: `${key}/${name}`, cameraKey: key, start: parsed.start, sizeBytes: st.size },
      mtimeMs: st.mtimeMs,
    });
  }
  rows.sort((a, b) => a.seg.start.getTime() - b.seg.start.getTime());
  return rows.map(({ seg, mtimeMs }, i) => {
    const next = rows[i + 1]?.seg;
    const gap = next ? Math.round((next.start.getTime() - seg.start.getTime()) / 1000) : Infinity;
    const mtime = Math.max(0, Math.round((mtimeMs - seg.start.getTime()) / 1000));
    const est = Math.min(gap, mtime);
    if (Number.isFinite(est)) seg.durationSec = est;
    return seg;
  });
}

/**
 * Đọc đĩa + sắp xếp theo start. cameraKey bỏ trống → quét mọi thư mục con hợp lệ.
 * from/to lọc theo overlap: segment giao với [from, to] được giữ.
 */
export async function listSegments(cameraKey?: string, from?: Date, to?: Date): Promise<RecordingSegment[]> {
  const root = recordingsDir();
  const keys = cameraKey === undefined ? await dirKeys(root) : isCameraKey(cameraKey) ? [cameraKey] : [];
  const out: RecordingSegment[] = [];
  for (const k of keys) out.push(...(await scanKeyDir(root, k)));
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out.filter((s) => {
    const endMs = s.start.getTime() + (s.durationSec ?? 0) * 1000;
    return (!from || endMs >= from.getTime()) && (!to || s.start.getTime() <= to.getTime());
  });
}

/* ---------------- dung lượng ---------------- */

export type StorageStatus = {
  /** Dung lượng trống của ổ chứa RECORDINGS_DIR; null khi không đo được. */
  freeBytes: number | null;
  totalBytes: number;
  cameras: { key: string; segments: number; bytes: number }[];
};

export async function storageStatus(): Promise<StorageStatus> {
  const root = recordingsDir();
  const segs = await listSegments();
  const byKey = new Map<string, { segments: number; bytes: number }>();
  for (const s of segs) {
    const e = byKey.get(s.cameraKey) ?? { segments: 0, bytes: 0 };
    e.segments++;
    e.bytes += s.sizeBytes;
    byKey.set(s.cameraKey, e);
  }
  let freeBytes: number | null = null;
  try {
    const fs = await statfs(root);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    /* ổ/thư mục chưa tồn tại hoặc statfs không hỗ trợ */
  }
  return {
    freeBytes,
    totalBytes: segs.reduce((a, s) => a + s.sizeBytes, 0),
    cameras: [...byKey].map(([key, v]) => ({ key, ...v })),
  };
}

/* ---------------- map camera → cameraKey ---------------- */

/**
 * Khóa thư mục bản ghi ứng viên của camera: streamName go2rtc (dai_cam_<id>,
 * quy ước khi mediaMTX đặt path theo stream) rồi basename của RTSP source
 * (deployment kiểu stack local: source trỏ thẳng mediaMTX → path `cam`).
 * Thứ tự giữ ổn định; dir nào không tồn tại trên đĩa đơn giản trả rỗng.
 */
export function recordingKeysFor(cam: { streamName: string | null; sourceCiphertext: string | null }): string[] {
  const keys: string[] = [];
  const push = (v: string | null | undefined) => {
    if (v && isCameraKey(v) && !keys.includes(v)) keys.push(v);
  };
  push(cam.streamName);
  try {
    const src = cam.sourceCiphertext ? decryptSource(cam.sourceCiphertext) : null;
    const last = src ? new URL(src).pathname.split("/").filter(Boolean).at(-1) : null;
    push(last);
  } catch {
    /* ciphertext/khoá lỗi — chỉ còn ứng viên streamName */
  }
  return keys;
}

/** Camera trong tenant mang các cột cần để resolve bản ghi; null → caller trả 404. */
export async function findRecordingCamera(tenantId: number, cameraId: number) {
  const [row] = await db
    .select({ id: cameras.id, name: cameras.name, streamName: cameras.streamName, sourceCiphertext: cameras.sourceCiphertext, retentionDays: cameras.retentionDays })
    .from(cameras)
    .where(and(eq(cameras.id, cameraId), eq(cameras.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

/* ---------------- purge + retention video ---------------- */

type AuditActor = { name?: string | null; role?: string | null; device?: string | null };
type AuditExecutor = Pick<typeof db, "insert">;

export type PurgeOptions = {
  cameraKey?: string;
  now?: Date;
  actor?: AuditActor;
  /** Tenant sở hữu thư mục bản ghi (theo camera); không có context ⇒ null. */
  tenantId?: number | null;
  executor?: AuditExecutor;
  /** "skip-empty" = không ghi audit khi deleted=0 (job nền chạy hằng ngày). */
  audit?: "always" | "skip-empty";
};
export type PurgeResult = { deleted: number; bytes: number; files: string[] };

/** Xoá segment có start cũ hơn retentionDays ngày; chỉ đụng file trong RECORDINGS_DIR. */
export async function purgeOldSegments(retentionDays: number, opts: PurgeOptions = {}): Promise<PurgeResult> {
  const root = recordingsDir();
  const result: PurgeResult = { deleted: 0, bytes: 0, files: [] };
  if (Number.isFinite(retentionDays) && retentionDays > 0) {
    const cutoff = (opts.now?.getTime() ?? Date.now()) - retentionDays * DAY_MS;
    const keys = opts.cameraKey === undefined ? await dirKeys(root) : dirOf(root, opts.cameraKey) ? [opts.cameraKey] : [];
    for (const key of keys) {
      const dir = dirOf(root, key)!;
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        const parsed = parseSegmentName(name);
        if (!parsed || parsed.start.getTime() >= cutoff) continue;
        const full = join(dir, name);
        const st = await stat(full).catch(() => null);
        if (!st?.isFile()) continue;
        const removed = await rm(full, { force: true }).then(() => true).catch(() => false);
        if (removed) {
          result.deleted++;
          result.bytes += st.size;
          result.files.push(`${key}/${name}`);
        }
      }
      await rmdir(dir).catch(() => {}); // dọn thư mục trống (no-op khi còn file)
    }
  }
  if (result.deleted > 0 || opts.audit !== "skip-empty") {
    await (opts.executor ?? db).insert(auditLog).values({
      tenantId: opts.tenantId ?? null,
      actor: opts.actor?.name ?? "system",
      actorRole: opts.actor?.role ?? null,
      device: opts.actor?.device ?? null,
      action: "recording.purge",
      targetType: "recording",
      targetId: opts.cameraKey ?? "*",
      detail: `days=${retentionDays} dir=${opts.cameraKey ?? "*"} deleted=${result.deleted} bytes=${result.bytes}`,
    });
  }
  return result;
}

/** retentionDays global (app_settings.retentionDays) — giống ngữ nghĩa runRetention. */
export async function globalRetentionDays(executor: Pick<typeof db, "select"> = db): Promise<number> {
  const [row] = await executor.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, "retentionDays"));
  return typeof row?.value === "number" && Number.isFinite(row.value) ? row.value : 30;
}

export type VideoRetentionReport = { deleted: number; bytes: number; dirs: number };

/**
 * Retention video: mỗi thư mục bản ghi xoá theo ngày giữ của camera sở hữu key
 * đó (streamName hoặc basename RTSP source). Ưu tiên: camera_settings.
 * retention_days (knob "Số ngày lưu trữ" trong drawer) → cameras.retention_days
 * >0 (card T-1323 §2.4) → global. Thư mục không map camera nào dùng global.
 * Gọi SAU khi transaction retention DB đã commit — xoá file không rollback được.
 */
export async function runVideoRetention(): Promise<VideoRetentionReport> {
  const globalDays = await globalRetentionDays();
  const rows = await db
    .select({
      streamName: cameras.streamName,
      sourceCiphertext: cameras.sourceCiphertext,
      camDays: cameras.retentionDays,
      setDays: cameraSettings.retentionDays,
      tenantId: cameras.tenantId,
    })
    .from(cameras)
    .leftJoin(cameraSettings, eq(cameraSettings.cameraId, cameras.id));
  const daysByKey = new Map<string, number>();
  const tenantByKey = new Map<string, number>();
  for (const r of rows) {
    const days = r.setDays ?? (r.camDays && r.camDays > 0 ? r.camDays : globalDays);
    for (const k of recordingKeysFor(r)) {
      daysByKey.set(k, days);
      tenantByKey.set(k, r.tenantId);
    }
  }
  const report: VideoRetentionReport = { deleted: 0, bytes: 0, dirs: 0 };
  if (globalDays <= 0) return report; // retention tắt ⇒ không xoá gì
  for (const key of await dirKeys(recordingsDir())) {
    const days = daysByKey.get(key) ?? globalDays;
    if (days <= 0) continue;
    const r = await purgeOldSegments(days, { cameraKey: key, actor: { name: "system" }, tenantId: tenantByKey.get(key) ?? null, audit: "skip-empty" });
    report.deleted += r.deleted;
    report.bytes += r.bytes;
    if (r.deleted) report.dirs++;
  }
  return report;
}

/* ---------------- quota dung lượng (M6) ---------------- */

const GiB = 1024 ** 3;

/** RECORDING_QUOTA_GB → byte; missing/không phải số/<=0 ⇒ 0 (quota tắt, không throw). */
function quotaCapBytes(): number {
  const gb = Number(process.env.RECORDING_QUOTA_GB);
  return Number.isFinite(gb) && gb > 0 ? gb * GiB : 0;
}

/** Mọi regular file dưới <dir> (đệ quy — layout <key>/<date>/<segment>). */
async function walkFiles(dir: string): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  const out: { path: string; size: number; mtimeMs: number }[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const full = join(dir, name);
    const st = await stat(full).catch(() => null);
    if (st?.isDirectory()) out.push(...(await walkFiles(full)));
    else if (st?.isFile()) out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** cameraKey → tenantId theo cameras (streamName/basename source) — giống runVideoRetention. */
async function recordingKeyTenants(): Promise<Map<string, number>> {
  const rows = await db.select({ streamName: cameras.streamName, sourceCiphertext: cameras.sourceCiphertext, tenantId: cameras.tenantId }).from(cameras);
  const map = new Map<string, number>();
  for (const r of rows) for (const k of recordingKeysFor(r)) map.set(k, r.tenantId);
  return map;
}

/**
 * Chọn file cần xoá để tổng <= capBytes: CŨ NHẤT trước (mtimeMs), KHÔNG BAO GIỜ
 * gồm file mới nhất (segment mediaMTX đang ghi) — kể cả khi điều đó để usage
 * trên cap. capBytes <= 0/NaN ⇒ quota tắt ⇒ [].
 */
export function selectOldestToDelete(
  files: { path: string; size: number; mtimeMs: number }[],
  capBytes: number,
): { path: string; size: number }[] {
  if (!Number.isFinite(capBytes) || capBytes <= 0) return [];
  let remaining = files.reduce((a, f) => a + f.size, 0);
  if (remaining <= capBytes) return [];
  const deletable = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, -1); // bỏ file mới nhất
  const out: { path: string; size: number }[] = [];
  for (const f of deletable) {
    if (remaining <= capBytes) break;
    out.push({ path: f.path, size: f.size });
    remaining -= f.size;
  }
  return out;
}

export type RecordingQuotaReport = { deleted: number; bytes: number; capped: number };

/**
 * Quota dung lượng per camera key (RECORDING_QUOTA_GB, mặc định tắt): mỗi thư
 * mục key quá cap thì xoá segment cũ nhất tới khi <= cap — chống một camera
 * lấp đầy đĩa. Ghi 1 audit "recording.quota_prune" cho mỗi key thực sự xoá.
 * opts.dir/capBytes để test trỏ thư mục tạm; production gọi không tham số.
 */
export async function enforceRecordingQuota(opts?: { capBytes?: number; dir?: string }): Promise<RecordingQuotaReport> {
  const cap = opts?.capBytes ?? quotaCapBytes();
  const report: RecordingQuotaReport = { deleted: 0, bytes: 0, capped: 0 };
  if (!Number.isFinite(cap) || cap <= 0) return report;
  const root = opts?.dir ?? recordingsDir();
  const tenantByKey = await recordingKeyTenants();
  for (const key of await dirKeys(root)) {
    const dir = dirOf(root, key);
    if (!dir) continue;
    const toDelete = selectOldestToDelete(await walkFiles(dir), cap);
    let freed = 0, n = 0;
    for (const f of toDelete) {
      const removed = await rm(f.path, { force: true }).then(() => true).catch(() => false);
      if (removed) { n++; freed += f.size; }
    }
    if (!n) continue;
    report.deleted += n;
    report.bytes += freed;
    report.capped++;
    await db.insert(auditLog).values({
      tenantId: tenantByKey.get(key) ?? null,
      actor: "system",
      action: "recording.quota_prune",
      targetType: "recording",
      targetId: key,
      detail: `capBytes=${cap} dir=${key} deleted=${n} freedMb=${(freed / 1024 ** 2).toFixed(1)}`,
    });
  }
  return report;
}
