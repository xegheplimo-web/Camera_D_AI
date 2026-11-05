/**
 * Keep-warm core: quản lý timer quét + map consumer theo camera id.
 * Thuần logic — không import DB/fetch/env trực tiếp; mọi IO đi qua KeepWarmIO
 * nên test được bằng node:test không cần Next/DB. Wiring thật ở keepwarm.ts.
 */
export const KEEPWARM_ENV = "GO2RTC_KEEPWARM";

export function keepWarmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[KEEPWARM_ENV] !== "0";
}

export interface KeepWarmIO {
  isEnabled(): boolean;
  listStreams(): Promise<Map<number, string>>;
  runConsumer(streamName: string, signal: AbortSignal): Promise<void>;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  scanMs: number;
}

export interface KeepWarm {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
  activeCount(): number;
}

export function createKeepWarm(io: KeepWarmIO): KeepWarm {
  const active = new Map<number, AbortController>();
  let timer: unknown = null;
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking || !io.isEnabled()) return;
    ticking = true;
    try {
      const want = await io.listStreams();
      for (const [id, name] of want) {
        if (active.has(id)) continue;
        const ctl = new AbortController();
        active.set(id, ctl);
        void io
          .runConsumer(name, ctl.signal)
          .catch(() => {})
          .finally(() => {
            if (active.get(id) === ctl) active.delete(id);
          });
      }
      for (const [id, ctl] of active) {
        if (!want.has(id)) {
          ctl.abort();
          active.delete(id);
        }
      }
    } catch {
      // list/DB lỗi thoáng qua — tick sau thử lại; không throw ra ngoài
    } finally {
      ticking = false;
    }
  }

  function start(): void {
    if (timer !== null || !io.isEnabled()) return;
    void tick();
    timer = io.setInterval(() => void tick(), io.scanMs);
    const h = timer as { unref?: () => void };
    if (h && typeof h.unref === "function") h.unref();
  }

  function stop(): void {
    if (timer !== null) io.clearInterval(timer);
    timer = null;
    for (const ctl of active.values()) ctl.abort();
    active.clear();
  }

  return { start, stop, tick, activeCount: () => active.size };
}
