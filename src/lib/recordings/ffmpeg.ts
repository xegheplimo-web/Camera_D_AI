import { spawn } from "node:child_process";
import { ffmpegPath } from "./clip";

/**
 * T-1347 — ffmpeg là phụ thuộc RUNTIME không khai báo: máy chủ thiếu ffmpeg thì
 * nút "Xuất clip" chỉ trả 502 sau khi đã quét đĩa. Probe một lần (cache 60 s) để
 * route trả 503 rõ ràng và UI biết trước mà tắt nút.
 */

export type FfmpegStatus = {
  available: boolean;
  path: string;
  version: string | null;
  error: string | null;
};

const TTL_MS = 60_000;
let cached: { at: number; value: FfmpegStatus } | null = null;

function probe(path: string, timeoutMs: number): Promise<FfmpegStatus> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    let proc: ReturnType<typeof spawn> | null = null;

    const finish = (v: FfmpegStatus) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        proc?.kill("SIGKILL");
      } catch {
        /* process đã chết */
      }
      finish({ available: false, path, version: null, error: "timeout" });
    }, timeoutMs);

    try {
      proc = spawn(path, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ available: false, path, version: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    proc.stdout?.on("data", (b: Buffer) => {
      out += b.toString();
    });
    proc.stderr?.on("data", (b: Buffer) => {
      err += b.toString();
    });
    proc.on("error", (e: Error) => finish({ available: false, path, version: null, error: e.message }));
    proc.on("close", (code: number | null) => {
      const line = out.split("\n").find((l) => l.trim().startsWith("ffmpeg version")) ?? "";
      if (code === 0 && line) finish({ available: true, path, version: line.trim().slice(0, 120), error: null });
      else finish({ available: false, path, version: null, error: (err.trim() || `exit ${code}`).slice(0, 200) });
    });
  });
}

/** Trạng thái ffmpeg (cache 60 s). `force` để test/buộc đo lại. */
export async function ffmpegStatus(opts: { force?: boolean } = {}): Promise<FfmpegStatus> {
  const path = ffmpegPath();
  if (!opts.force && cached && cached.value.path === path && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = await probe(path, 3000);
  cached = { at: Date.now(), value };
  return value;
}

/** Xoá cache — chỉ dùng trong test. */
export function resetFfmpegCache(): void {
  cached = null;
}
