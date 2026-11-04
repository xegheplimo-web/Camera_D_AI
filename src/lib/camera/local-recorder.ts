/**
 * "Ghi vào máy" — browser-side recording, framework-free và dependency-injected
 * để test không cần DOM/MediaRecorder. Module KHÔNG tự ghi đĩa: kết quả đi qua
 * deps.deliver(blob, fileName); UI gắn Blob vào `<a download>` để trình duyệt
 * hỏi người dùng nơi lưu. Không dính tới recorder MediaMTX phía server.
 */
export const MAX_LOCAL_CLIP_SECONDS = 600;

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  "video/mp4;codecs=avc1",
  "video/mp4",
] as const;

export function pickMimeType(isSupported: (type: string) => boolean): string | null {
  for (const mime of MIME_CANDIDATES) {
    try {
      if (isSupported(mime)) return mime;
    } catch {
      // Một số trình duyệt ném trên codec lạ thay vì trả false — coi như không hỗ trợ.
    }
  }
  return null;
}

function slugify(name: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
  const slug = ascii
    .toLowerCase()
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "camera";
}

export function recordingFileName(cameraName: string, startedAt: Date, ext = "webm"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${startedAt.getFullYear()}${p(startedAt.getMonth() + 1)}${p(startedAt.getDate())}-${p(startedAt.getHours())}${p(startedAt.getMinutes())}${p(startedAt.getSeconds())}`;
  return `${slugify(cameraName)}_${stamp}.${ext}`;
}

export type LocalRecorderDeps = {
  startStream: () => { stream: MediaStream; stop: () => void } | null;
  recorderFactory: (stream: MediaStream, mimeType: string) => {
    start(): void;
    stop(): void;
    ondataavailable: ((e: { data: Blob }) => void) | null;
    onstop: (() => void) | null;
    state: string;
  };
  deliver: (blob: Blob, fileName: string) => void;
  now: () => number;
};

export function createLocalRecorder(
  deps: LocalRecorderDeps,
  cameraName: string,
  mime?: string | null,
): {
  start(): { ok: true } | { ok: false; reason: string };
  stop(): void;
  state(): "idle" | "recording";
  elapsedSeconds(): number;
} {
  const mimeType = mime === undefined ? "video/webm" : mime;
  const ext = mimeType?.includes("mp4") ? "mp4" : "webm";

  let phase: "idle" | "recording" | "stopping" = "idle";
  let recorder: ReturnType<LocalRecorderDeps["recorderFactory"]> | null = null;
  let releaseStream: (() => void) | null = null;
  let chunks: Blob[] = [];
  let startedAtMs = 0;

  const finish = () => {
    phase = "idle";
    recorder = null;
    try {
      releaseStream?.();
    } catch {
      // Nhả stream lỗi không được phá vỡ chu trình stop.
    }
    releaseStream = null;
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: mimeType ? mimeType.split(";")[0] : "video/webm" });
    chunks = [];
    deps.deliver(blob, recordingFileName(cameraName, new Date(startedAtMs), ext));
  };

  const api = {
    start(): { ok: true } | { ok: false; reason: string } {
      if (phase !== "idle") return { ok: true }; // start kép = no-op, không mở recorder thứ hai
      if (mimeType === null) return { ok: false, reason: "unsupported-mime" };
      const source = deps.startStream();
      if (!source) return { ok: false, reason: "no-source" };
      let rec: ReturnType<LocalRecorderDeps["recorderFactory"]>;
      try {
        rec = deps.recorderFactory(source.stream, mimeType);
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size) chunks.push(e.data);
        };
        rec.onstop = finish;
        rec.start();
      } catch (err) {
        try {
          source.stop();
        } catch {
          // bỏ qua — đã fail rồi
        }
        return { ok: false, reason: err instanceof Error ? err.message : "recorder-failed" };
      }
      recorder = rec;
      releaseStream = source.stop;
      chunks = [];
      startedAtMs = deps.now();
      phase = "recording";
      return { ok: true };
    },
    stop() {
      if (phase !== "recording" || !recorder) return; // stop không-start = no-op
      phase = "stopping";
      try {
        recorder.stop(); // recorder phải bắn onstop → finish()
      } catch {
        finish(); // impl ném khi đã inactive — vẫn dọn sạch
      }
    },
    state(): "idle" | "recording" {
      return phase === "recording" ? "recording" : "idle";
    },
    elapsedSeconds(): number {
      if (phase !== "recording") return 0;
      const elapsed = Math.max(0, Math.floor((deps.now() - startedAtMs) / 1000));
      if (elapsed >= MAX_LOCAL_CLIP_SECONDS) api.stop();
      return elapsed;
    },
  };
  return api;
}
