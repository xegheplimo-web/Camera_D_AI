"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, Square } from "lucide-react";
import { createLocalRecorder, pickMimeType, type LocalRecorderDeps } from "@/lib/camera/local-recorder";

type FrameSource = { el: HTMLVideoElement | HTMLImageElement; w: number; h: number };
type RecorderApi = ReturnType<typeof createLocalRecorder>;

const CANVAS_FPS = 10;

export default function LocalRecordButton({ cameraName, getSource }: { cameraName: string; getSource: () => FrameSource | null }) {
  // undefined = chưa probe (server HTML và hydrate khớp nhau); null = không hỗ trợ.
  const [mime, setMime] = useState<string | null | undefined>(undefined);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const getSourceRef = useRef(getSource);
  const recRef = useRef<RecorderApi | null>(null);

  useEffect(() => {
    getSourceRef.current = getSource;
  });
  useEffect(() => {
    setMime(typeof MediaRecorder === "undefined" ? null : pickMimeType((t) => MediaRecorder.isTypeSupported(t)));
  }, []);

  const deps = useMemo<LocalRecorderDeps>(
    () => ({
      now: () => Date.now(),
      startStream: () => {
        const s = getSourceRef.current();
        if (!s) return null;
        const el = s.el;
        // Webcam: <video> có srcObject là MediaStream thật — ghi trực tiếp, stream
        // thuộc view nên stop() không được giết track.
        if (el instanceof HTMLVideoElement && el.srcObject instanceof MediaStream) {
          return { stream: el.srcObject, stop: () => {} };
        }
        // MJPEG <img>: MediaRecorder không đọc được — vẽ frame đã decode vào
        // canvas ~10fps rồi captureStream.
        const canvas = document.createElement("canvas");
        canvas.width = s.w;
        canvas.height = s.h;
        const ctx = canvas.getContext("2d");
        if (!ctx || typeof canvas.captureStream !== "function") return null;
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        const timer = setInterval(() => {
          if ((el as HTMLImageElement).naturalWidth) ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        }, 1000 / CANVAS_FPS);
        const stream = canvas.captureStream(CANVAS_FPS);
        return {
          stream,
          stop: () => {
            clearInterval(timer);
            for (const t of stream.getTracks()) t.stop();
          },
        };
      },
      recorderFactory: (stream, mimeType) => {
        const mr = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 900_000 });
        const handle = {
          ondataavailable: null as ((e: { data: Blob }) => void) | null,
          onstop: null as (() => void) | null,
          start: () => mr.start(),
          stop: () => mr.stop(),
          get state() {
            return mr.state;
          },
        };
        mr.ondataavailable = (e) => handle.ondataavailable?.(e);
        mr.onstop = () => handle.onstop?.();
        return handle;
      },
      deliver: (blob, fileName) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
    }),
    [],
  );

  // Component được key theo cam.id — đổi camera/unmount ⇒ cleanup stop() ghi ngay
  // (phần đã ghi vẫn được deliver), state reset nhờ remount.
  useEffect(() => {
    if (mime === undefined) return;
    const rec = createLocalRecorder(deps, cameraName, mime);
    recRef.current = rec;
    return () => {
      rec.stop();
      if (recRef.current === rec) recRef.current = null;
    };
  }, [cameraName, mime, deps]);

  // Đồng hồ hiển thị + driver auto-stop: elapsedSeconds() tự stop() khi chạm trần.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const rec = recRef.current;
      if (!rec) return;
      setElapsed(rec.elapsedSeconds());
      if (rec.state() !== "recording") setRecording(false);
    }, 500);
    return () => clearInterval(t);
  }, [recording]);

  const toggle = () => {
    const rec = recRef.current;
    if (!rec) return;
    if (recording) {
      rec.stop();
      setRecording(false);
      return;
    }
    const r = rec.start();
    if (r.ok) {
      setRecording(true);
      setElapsed(0);
      setErr(null);
    } else {
      setErr(r.reason === "no-source" ? "Chưa có khung hình để ghi" : "Không ghi được trong trình duyệt này");
      setTimeout(() => setErr(null), 2600);
    }
  };

  if (mime === null) {
    return (
      <span role="note" className="rounded-lg bg-black/60 px-2 py-1.5 text-xs font-semibold text-slate-300">
        Không hỗ trợ ghi trong trình duyệt này
      </span>
    );
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-pressed={recording}
        disabled={mime === undefined}
        onClick={toggle}
        title={recording ? "Dừng và lưu clip về máy" : "Ghi khung hình đang xem về máy bạn"}
        className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold backdrop-blur transition disabled:opacity-50 ${
          recording ? "bg-red-600/80 hover:bg-red-500/80" : "bg-black/60 hover:bg-cyan-600/60"
        }`}
      >
        {recording ? <Square className="h-3.5 w-3.5" /> : <Circle className="h-3.5 w-3.5 text-red-400" />}
        {recording ? `Dừng và lưu (${mm}:${ss})` : "Ghi vào máy"}
      </button>
      {err && (
        <span className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-black/85 px-2 py-1 text-[10px] text-amber-200">
          {err}
        </span>
      )}
    </span>
  );
}
