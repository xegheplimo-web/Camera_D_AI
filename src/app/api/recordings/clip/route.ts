import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { audit, problem } from "@/lib/audit";
import { HttpError } from "@/lib/http-guard";
import { denied, queryCameraId, withTenant } from "@/lib/knowledge/http";
import { findRecordingCamera, listSegments, recordingsDir, recordingKeysFor } from "@/lib/recordings";
import { ffmpegStatus } from "@/lib/recordings/ffmpeg";
import {
  buildClipArgs,
  buildConcatManifest,
  CLIP_TIMEOUT_MS,
  ffmpegPath,
  pickClipSegments,
  validateClipRange,
} from "@/lib/recordings/clip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/** Segment còn "tươi" hơn ngưỡng này coi như đang ghi dở — không đưa vào clip. */
const WRITING_GRACE_MS = 10_000;

function queryInstant(u: URL, name: string): Date {
  const raw = u.searchParams.get(name);
  const d = raw ? new Date(raw) : null;
  if (!d || Number.isNaN(d.getTime()))
    throw new HttpError(400, "INVALID_RANGE", `Tham số ${name} phải là thời điểm RFC3339 hợp lệ.`);
  return d;
}

/**
 * Chạy ffmpeg tới file đích; resolve {code, stderr} — code null = bị kill quá
 * timeout, -1 = spawn lỗi (thiếu binary). Stderr giữ 4 KB cuối để log 502.
 */
function runFfmpeg(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stderr });
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpegPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      resolve({ code: -1, stderr: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => proc.kill("SIGKILL"), CLIP_TIMEOUT_MS);
    proc.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-4096);
    });
    proc.on("error", (e) => {
      stderr = (stderr + " " + e.message).slice(-4096);
      finish(-1);
    });
    proc.on("close", (code) => finish(code));
  });
}

/** Che đường dẫn tuyệt đối trong stderr: chỉ giữ basename, lấy 200 ký tự cuối. */
function sanitizeStderr(stderr: string, paths: string[]): string {
  let s = stderr;
  for (const p of paths) s = s.split(p).join(basename(p));
  s = s.replace(/[A-Za-z]:[\\/][^\s"'\\]+/g, (m) => basename(m)); // C:\path\to\x → x
  s = s.replace(/(^|[\s"'])\/[^\s"']+/g, (_m, pre: string) => pre + basename(_m.trim())); // /abs/x → x
  return s.trim().slice(-200);
}

/**
 * GET /api/recordings/clip?cameraId&from&to[&download=1] — cắt khoảng bản ghi
 * bằng stream copy: chọn mọi segment giao [from,to), concat khi >1, ffmpeg ra
 * file tạm trong RECORDINGS_DIR/.tmp rồi stream lại (xoá temp sau khi gửi).
 */
export async function GET(req: Request) {
  return withTenant("read", async ({ tenantId }) => {
    const u = new URL(req.url);
    const cameraId = queryCameraId(u);
    if (cameraId === undefined) throw new HttpError(400, "CAMERA_REQUIRED", "Thiếu tham số cameraId.");
    const from = queryInstant(u, "from");
    const to = queryInstant(u, "to");
    const range = { from, to };
    const valid = validateClipRange(range);
    if (!valid.ok) throw new HttpError(400, valid.code, valid.message);

    const cam = await findRecordingCamera(tenantId, cameraId);
    if (!cam) return denied("camera", cameraId);

    // ffmpeg là phụ thuộc runtime: thiếu binary ⇒ 503 nói rõ, không để client
    // nhận 502 "Không xuất được clip" (dễ bị chẩn đoán nhầm là file hỏng).
    const ff = await ffmpegStatus();
    if (!ff.available) {
      await audit("recording.clip_unavailable", { targetType: "camera", targetId: cameraId, detail: `path=${ff.path} err=${ff.error ?? "unknown"}` });
      return problem(503, "Máy chủ chưa cài ffmpeg nên chưa xuất được clip.", ff.error ?? undefined);
    }

    const lists = await Promise.all(recordingKeysFor(cam).map((k) => listSegments(k, from, to)));
    const picked = pickClipSegments(lists.flat(), range);

    // Loại segment đang ghi dở (mtime < 10 s trước) — file chưa đóng, ffmpeg
    // copy sẽ ra clip lỗi; cũng loại file biến mất giữa lúc list và stat.
    const root = recordingsDir();
    const usable: { file: string; path: string; start: Date; durationSec: number }[] = [];
    for (const s of picked) {
      const path = join(root, s.file);
      const st = await stat(path).catch(() => null);
      if (st?.isFile() && Date.now() - st.mtimeMs >= WRITING_GRACE_MS)
        usable.push({ ...s, path });
    }
    if (!usable.length) return problem(404, "Không có bản ghi trong khoảng này");

    const tmpDir = join(root, ".tmp");
    await mkdir(tmpDir, { recursive: true });
    const tag = randomBytes(8).toString("hex");
    const outPath = join(tmpDir, `clip-${tag}.mp4`);
    const listPath = usable.length > 1 ? join(tmpDir, `clip-${tag}.txt`) : undefined;
    const cleanup = () => {
      void rm(outPath, { force: true }).catch(() => {});
      if (listPath) void rm(listPath, { force: true }).catch(() => {});
    };

    try {
      let args: string[];
      if (usable.length === 1) {
        const offsetSec = Math.max(0, (from.getTime() - usable[0].start.getTime()) / 1000);
        const durationSec = (to.getTime() - from.getTime()) / 1000;
        args = buildClipArgs({ files: [usable[0].path], offsetSec, durationSec, out: outPath });
      } else {
        // inpoint/outpoint trong manifest cắt đúng từng file; -t = tổng độ dài
        // đã trim áp lên kết quả concat (offset đầu luôn 0).
        await writeFile(listPath!, buildConcatManifest(usable.map((s) => ({ path: s.path, start: s.start, durationSec: s.durationSec })), range), "utf8");
        const durationSec = usable.reduce((a, s) => {
          const end = Math.min(s.start.getTime() + s.durationSec * 1000, to.getTime());
          return a + (end - Math.max(s.start.getTime(), from.getTime())) / 1000;
        }, 0);
        args = buildClipArgs({ files: usable.map((s) => s.path), offsetSec: 0, durationSec, listFile: listPath!, out: outPath });
      }

      const { code, stderr } = await runFfmpeg(args);
      if (code === -1) {
        // spawn thất bại (binary biến mất sau khi probe, hoặc thiếu quyền).
        const detail = sanitizeStderr(stderr, usable.map((s) => s.path)) || "spawn failed";
        await audit("recording.clip_unavailable", { targetType: "camera", targetId: cameraId, detail });
        cleanup();
        return problem(503, "Máy chủ chưa cài ffmpeg nên chưa xuất được clip.", detail);
      }
      if (code !== 0) {
        const detail = sanitizeStderr(stderr, usable.map((s) => s.path)) || `ffmpeg exit ${code}`;
        await audit("recording.clip_failed", { targetType: "camera", targetId: cameraId, detail: `code=${code} ${detail}` });
        cleanup();
        return problem(502, "Không xuất được clip.", detail);
      }
      const st = await stat(outPath).catch(() => null);
      if (!st?.isFile() || st.size <= 0) {
        await audit("recording.clip_failed", { targetType: "camera", targetId: cameraId, detail: "empty output" });
        cleanup();
        return problem(502, "Không xuất được clip.", "ffmpeg không tạo được output.");
      }

      const headers = new Headers({
        "Content-Type": "video/mp4",
        "Content-Length": String(st.size),
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
      });
      if (u.searchParams.get("download") === "1") {
        const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-");
        headers.set("Content-Disposition", `attachment; filename="clip-${cameraId}-${stamp(from)}-${stamp(to)}.mp4"`);
      }
      // Thành công: stream file tạm ra client, xoá temp khi stream đóng/hủy.
      const stream = createReadStream(outPath);
      stream.on("error", (e) => {
        void audit("recording.clip_failed", { targetType: "camera", targetId: cameraId, detail: `stream err=${e.message}` });
        stream.destroy();
      });
      stream.on("close", cleanup);
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers });
    } catch (e) {
      cleanup();
      throw e;
    }
  });
}
