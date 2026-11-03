/**
 * T-1346 — guard một-instance cho detector bằng Postgres advisory lock.
 *
 * Vì sao cần: mỗi process `next start` đều gọi `startDetector()` trong
 * instrumentation, nên chạy 2 server (worktree/dev + production) là 2 vòng
 * detector cùng ghi event cho một camera. Đo trên DB thật: 156 event/giờ/camera
 * dù cooldown thiết kế là 60 s (trần 60/giờ), có 2 event cách nhau 2 ms.
 *
 * Cách làm: giữ **một** `pg.Client` cho cả process (advisory lock là
 * session-scoped, không dùng pool) và acquire `pg_try_advisory_lock(47001, cameraId)`
 * cho từng camera. Process không acquire được ⇒ standby, không gọi go2rtc.
 * Lock tự nhả khi session chết (kill -9), nên standby tiếp quản được.
 */

import { Client } from "pg";

/** Namespace cố định cho lock của detector (2 số int4 của pg_try_advisory_lock). */
export const LEASE_CLASS = 47001;

/** Không thử acquire lại dày hơn mức này khi đang standby. */
const RETRY_MS = 30_000;

/** Cho test hạ thời gian retry (mặc định 30 s) — không dùng cho production. */
function retryMs(): number {
  const raw = Number(process.env.DETECTOR_LEASE_RETRY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : RETRY_MS;
}

export type LeaseStatus = {
  connected: boolean;
  owned: number[];
  standby: number[];
  lastAttemptAt: string | null;
  lastError: string | null;
};

/** Khoá advisory 2 thành phần: (classid, objid) — objid chính là cameraId. */
export function leaseKeyFor(cameraId: number): { classid: number; objid: number } {
  if (!Number.isInteger(cameraId) || cameraId < 1 || cameraId > 2147483647) {
    throw new Error("cameraId không hợp lệ cho detector lease");
  }
  return { classid: LEASE_CLASS, objid: cameraId };
}

export class DetectorLease {
  private client: Client | null = null;
  private connected = false;
  private owned = new Set<number>();
  private wanted = new Set<number>();
  private inflight: Promise<void> | null = null;
  private lastAttemptMs = 0;
  private lastAttemptAt: string | null = null;
  private lastError: string | null = null;

  owns(cameraId: number): boolean {
    return this.connected && this.owned.has(cameraId);
  }

  get status(): LeaseStatus {
    return {
      connected: this.connected,
      owned: [...this.owned].sort((a, b) => a - b),
      standby: [...this.wanted].filter((id) => !this.owned.has(id)).sort((a, b) => a - b),
      lastAttemptAt: this.lastAttemptAt,
      lastError: this.lastError,
    };
  }

  /**
   * Acquire lock cho camera mới, nhả lock của camera đã gỡ. An toàn khi gọi
   * đồng thời (một promise in-flight). Không throw: lỗi DB ⇒ connected=false,
   * mọi camera thành standby (fail-closed, tránh ghi trùng).
   */
  ensure(cameraIds: number[]): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doEnsure(cameraIds).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connected = false;
    this.owned.clear();
    if (!client) return;
    try {
      await client.end();
    } catch {
      /* session đã chết — lock đã được Postgres nhả */
    }
  }

  private async doEnsure(cameraIds: number[]): Promise<void> {
    this.wanted = new Set(cameraIds);
    if (!this.connected) {
      if (!(await this.connect())) return;
    }
    const client = this.client;
    if (!client) return;

    // Nhả camera đã gỡ khỏi DB.
    for (const id of [...this.owned]) {
      if (this.wanted.has(id)) continue;
      const { classid, objid } = leaseKeyFor(id);
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [classid, objid]);
      } catch (e) {
        this.noteError(e);
      }
      this.owned.delete(id);
    }

    // Acquire camera mới, tối đa 1 lần/30 s.
    const missing = [...this.wanted].filter((id) => !this.owned.has(id));
    if (!missing.length) return;
    const now = Date.now();
    if (this.lastAttemptMs && now - this.lastAttemptMs < retryMs()) return;
    this.lastAttemptMs = now;
    this.lastAttemptAt = new Date(now).toISOString();

    for (const id of missing) {
      const { classid, objid } = leaseKeyFor(id);
      try {
        const res = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [classid, objid]);
        if (res.rows[0]?.locked === true) this.owned.add(id);
      } catch (e) {
        this.noteError(e);
        if (!this.connected) return;
      }
    }
    this.lastError = this.owned.size === this.wanted.size ? null : this.lastError;
  }

  private async connect(): Promise<boolean> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      this.lastError = "thiếu DATABASE_URL";
      return false;
    }
    const client = new Client({ connectionString });
    try {
      await client.connect();
      this.client = client;
      this.connected = true;
      this.lastError = null;
      client.on("error", (e) => {
        this.connected = false;
        this.owned.clear();
        this.noteError(e);
      });
      client.on("end", () => {
        this.connected = false;
        this.owned.clear();
      });
      return true;
    } catch (e) {
      this.noteError(e);
      try {
        await client.end();
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  private noteError(e: unknown): void {
    this.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
}
