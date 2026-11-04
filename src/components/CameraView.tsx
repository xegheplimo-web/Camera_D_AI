"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera as CamIcon, Maximize2, Minimize2, ScanEye, Circle, Square, Star, NotebookPen, Video, VideoOff, ArrowLeftRight, Loader2, RefreshCw, Settings } from "lucide-react";
import { api, drawToCanvas, uploadDataUrl, blobToDataUrl, getDetector } from "@/lib/client";
import { streamBadge } from "@/lib/camera/status";
import { vi } from "@/lib/labels";
import { useApp } from "./AppState";

export type Cam = { id: number; code: string; name: string; location: string; sourceType: string; thumbnail: string | null; status: string; sourceHost?: string | null; streamName?: string | null; enabled?: boolean };

type Track = { id: number; cls: string; cx: number; cy: number; seen: number; side: number; pending: number; pendingCount: number; lastCross: number; seq: number };
type Box = { x: number; y: number; w: number; h: number; label: string; score: number; id?: number; cls: string };

const COLORS: Record<string, string> = { person: "#22c55e", car: "#f43f5e", motorcycle: "#d946ef", truck: "#f97316", bus: "#f97316", bicycle: "#eab308" };

export default function CameraView({ cam, compact = false, onEvent, onSettings }: { cam: Cam; compact?: boolean; onEvent?: () => void; onSettings?: () => void }) {
  const router = useRouter();
  const { setMood } = useApp();
  useEffect(() => {
    // Webcam/demo không có pipeline phía máy chủ — status DB của chúng không mang nghĩa "mất kết nối".
    if (cam.status === "offline" && cam.sourceType === "rtsp") setMood("alert");
  }, [cam.status, cam.sourceType, setMood]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const tracksRef = useRef<Map<number, Track>>(new Map());
  const nextIdRef = useRef(1);
  const epochRef = useRef(Date.now());
  const recRef = useRef<MediaRecorder | null>(null);
  const restartRef = useRef<() => void>(() => {});
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [streamRevision, setStreamRevision] = useState(0);


  const [live, setLive] = useState(false);
  const [streamState, setStreamState] = useState<"off" | "connecting" | "live" | "lost">("off");
  const [detect, setDetect] = useState(false);
  const [detState, setDetState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [lineX, setLineX] = useState(0.5);
  const [showLine, setShowLine] = useState(true);
  const [invert, setInvert] = useState(false);
  const [counts, setCounts] = useState({ in: 0, out: 0 });
  const [recording, setRecording] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const isWebcam = cam.sourceType === "webcam";
  const isRtsp = cam.sourceType === "rtsp";

  useEffect(() => {
    if (!isWebcam || !navigator.mediaDevices?.enumerateDevices) return;
    let active = true;
    const refresh = async () => {
      try {
        const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        if (!active) return;
        setDevices(all);
        const stored = window.localStorage.getItem("dai_webcam_device") || "";
        setSelectedDeviceId((current) => all.some((d) => d.deviceId === current) ? current : all.some((d) => d.deviceId === stored) ? stored : all[0]?.deviceId || "");
        if (streamRef.current && !streamRef.current.getVideoTracks().some((t) => t.readyState === "live")) restartRef.current();
      } catch { if (active) setDevices([]); }
    };
    void refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => { active = false; navigator.mediaDevices.removeEventListener?.("devicechange", refresh); };
  }, [isWebcam]);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2600);
  };

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Đồng bộ trạng thái toàn màn hình thật — kể cả khi người dùng thoát bằng ESC.
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(document.fullscreenElement === wrapRef.current);
    onFsChange();
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Một nút duy nhất: bấm lại đúng nút đó thì thu nhỏ (trước đây chỉ có
  // requestFullscreen() nên bấm lại là no-op, buộc người dùng phải bấm Esc).
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement === wrapRef.current) {
        await document.exitFullscreen?.();
      } else {
        await wrapRef.current?.requestFullscreen?.();
      }
    } catch (error) {
      console.error("Fullscreen failed:", error);
    }
  }, []);

  const stopWebcam = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLive(false);
    setStreamState("off");
  }, []);

  useEffect(() => {
    stopWebcam();
    setBoxes([]);
    setCounts({ in: 0, out: 0 });
    tracksRef.current.clear();
    return () => stopWebcam();
  }, [cam.id, stopWebcam]);

  const startWebcam = async () => {
    setStreamState("connecting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Trình duyệt cần HTTPS hoặc localhost để mở webcam.");
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
      if (selectedDeviceId) video.deviceId = { ideal: selectedDeviceId };
      const s = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      streamRef.current = s;
      const id = s.getVideoTracks()[0]?.getSettings().deviceId;
      if (id) window.localStorage.setItem("dai_webcam_device", id);
      s.getVideoTracks()[0]?.addEventListener("ended", () => {
        if (streamRef.current !== s) return;
        setLive(false); setStreamState("lost");
        if (retryCount.current < 5) {
          retryCount.current++;
          retryTimer.current = setTimeout(() => restartRef.current(), Math.min(15000, retryCount.current * 2000));
        }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        await videoRef.current.play();
      }
      retryCount.current = 0;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      setStreamState("live");
      epochRef.current = Date.now(); // new epoch: track ids never reused across sessions
      tracksRef.current.clear();
      setLive(true);
    } catch (e) {
      setStreamState("lost");
      flash(e instanceof Error ? e.message : "Không kết nối được webcam. Kiểm tra quyền và thiết bị.");
      // Only retry a previously authorized camera. Never loop browser permission prompts.
      if (retryCount.current > 0 && retryCount.current < 5) {
        retryCount.current++;
        retryTimer.current = setTimeout(() => restartRef.current(), Math.min(15000, retryCount.current * 2000));
      }
    }
  };
  restartRef.current = () => { if (isWebcam) void startWebcam(); };

  // Automatically reconnect only after the user has previously granted camera permission.
  // Do not trigger a new browser permission prompt merely by opening this page.
  const triedAutoRestore = useRef(false);
  useEffect(() => {
    if (!isWebcam || triedAutoRestore.current || !navigator.permissions?.query) return;
    triedAutoRestore.current = true;
    navigator.permissions.query({ name: "camera" as PermissionName }).then((permission) => {
      if (permission.state === "granted") restartRef.current();
    }).catch(() => { /* browsers may not support camera Permissions API */ });
  }, [isWebcam]);

  const reconnectIp = async () => {
    setStreamState("connecting");
    try {
      await api(`/api/cameras/${cam.id}/connect`, { method: "POST", json: {} });
      setStreamRevision((n) => n + 1);
      flash("Đã gửi yêu cầu kết nối. Chờ xác nhận khung hình từ camera.");
    } catch (error) {
      setStreamState("lost");
      flash(error instanceof Error ? error.message : "Không kết nối được IP camera.");
    }
  };

  const source = (): { el: HTMLVideoElement | HTMLImageElement; w: number; h: number } | null => {
    if (live && videoRef.current && videoRef.current.videoWidth) return { el: videoRef.current, w: videoRef.current.videoWidth, h: videoRef.current.videoHeight };
    if ((cam.sourceType === "demo" || (isRtsp && streamState === "live")) && imgRef.current && imgRef.current.naturalWidth)
      return { el: imgRef.current, w: imgRef.current.naturalWidth, h: imgRef.current.naturalHeight };
    return null;
  };

  const captureAsset = async (maxDim = 1280, origin = "capture") => {
    const s = source();
    if (!s) throw new Error("Chưa có khung hình");
    const c = drawToCanvas(s.el, s.w, s.h, maxDim);
    return uploadDataUrl(c.toDataURL("image/jpeg", 0.88), { width: c.width, height: c.height, origin, cameraId: cam.id });
  };

  const postEvent = async (body: Record<string, unknown>) => {
    await api("/api/events", { method: "POST", json: { cameraId: cam.id, ...body } });
    onEvent?.();
  };

  // crossing -> event (idempotent per camera/epoch/track/seq)
  const emitCrossing = useCallback(
    async (t: Track, dir: "in" | "out") => {
      setCounts((c) => ({ ...c, [dir]: c[dir] + 1 }));
      try {
        const a = await captureAsset(640);
        await postEvent({
          type: dir === "in" ? "person_in" : "person_out",
          objectClass: "person",
          label: `${dir === "in" ? "Khách vào" : "Khách ra"} (ID: ${String(t.id).padStart(3, "0")})`,
          trackId: `${epochRef.current}-${t.id}`,
          confidence: 0.9,
          assetId: a.id,
          tags: ["khách", "đếm qua vạch"],
          clientReported: true,
          idempotencyKey: `${cam.id}-${epochRef.current}-${t.id}-${t.seq}`,
        });
      } catch {
        /* keep counting locally even if network fails */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cam.id]
  );

  // detection loop
  useEffect(() => {
    if (!detect) {
      setBoxes([]);
      return;
    }
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    setDetState((s) => (s === "ready" ? s : "loading"));
    getDetector()
      .then((det) => {
        if (stop) return;
        setDetState("ready");
        const loop = async () => {
          if (stop) return;
          const s = source();
          if (s) {
            try {
              const preds = await det.detect(s.el, 20, 0.45);
              const nowT = Date.now();
              const tracks = tracksRef.current;
              const out: Box[] = [];
              for (const p of preds) {
                const [x, y, w, h] = p.bbox;
                const b: Box = { x: x / s.w, y: y / s.h, w: w / s.w, h: h / s.h, label: vi(p.class), score: p.score, cls: p.class };
                if (live && (p.class === "person" || p.class === "car" || p.class === "motorcycle")) {
                  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
                  let best: Track | null = null;
                  let bd = 0.18;
                  for (const t of tracks.values()) {
                    if (t.cls !== p.class || nowT - t.seen > 15000) continue;
                    const d = Math.hypot(t.cx - cx, t.cy - cy);
                    if (d < bd) { bd = d; best = t; }
                  }
                  const side = cx < lineX - 0.03 ? -1 : cx > lineX + 0.03 ? 1 : 0; // hysteresis band
                  if (!best) {
                    best = { id: nextIdRef.current++, cls: p.class, cx, cy, seen: nowT, side, pending: 0, pendingCount: 0, lastCross: 0, seq: 0 };
                    tracks.set(best.id, best);
                  } else {
                    best.cx = cx; best.cy = cy; best.seen = nowT;
                    if (p.class === "person" && showLine && side !== 0 && best.side !== 0 && side !== best.side) {
                      // require k=2 stable observations on new side
                      if (best.pending === side) best.pendingCount++;
                      else { best.pending = side; best.pendingCount = 1; }
                      if (best.pendingCount >= 2 && nowT - best.lastCross > 3000) {
                        const movedRight = side === 1;
                        const dir: "in" | "out" = movedRight !== invert ? "in" : "out";
                        best.side = side; best.lastCross = nowT; best.seq++; best.pending = 0; best.pendingCount = 0;
                        emitCrossing(best, dir);
                      }
                    } else if (side !== 0 && best.side === 0) best.side = side;
                    else if (side === best.side) { best.pending = 0; best.pendingCount = 0; }
                  }
                  b.id = best.id;
                }
                out.push(b);
              }
              for (const [id, t] of tracks) if (nowT - t.seen > 30000) tracks.delete(id);
              if (!stop) setBoxes(out);
            } catch (error) {
              if (!stop) {
                setDetState("error"); setDetect(false); setBoxes([]);
                flash(error instanceof Error ? error.message : "Nhận diện hình ảnh không khả dụng. Camera vẫn xem/chụp được.");
              }
              return;
            }
          }
          timer = setTimeout(loop, 3000);
        };
        loop();
      })
      .catch(() => {
        setDetState("error");
        setDetect(false);
        flash("Không kết nối được nhận diện hình ảnh. Hãy thử lại sau.");
      });
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detect, live, lineX, showLine, invert, cam.id, emitCrossing]);

  // draw overlay
  useEffect(() => {
    const c = overlayRef.current;
    const w = wrapRef.current;
    if (!c || !w) return;
    const r = w.getBoundingClientRect();
    c.width = r.width * devicePixelRatio;
    c.height = r.height * devicePixelRatio;
    const ctx = c.getContext("2d")!;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.clearRect(0, 0, r.width, r.height);
    if (showLine && live) {
      ctx.strokeStyle = "#22e3ff";
      ctx.setLineDash([8, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lineX * r.width, 0);
      ctx.lineTo(lineX * r.width, r.height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(34,227,255,0.9)";
      ctx.font = "bold 11px system-ui";
      ctx.fillText(invert ? "← VÀO" : "VÀO →", lineX * r.width + 6, 16);
    }
    for (const b of boxes) {
      const col = COLORS[b.cls] ?? "#38bdf8";
      const x = b.x * r.width, y = b.y * r.height, bw = b.w * r.width, bh = b.h * r.height;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, bw, bh);
      const text = `${b.label.charAt(0).toUpperCase() + b.label.slice(1)}${b.id ? ` (ID: ${String(b.id).padStart(3, "0")})` : ""} ${(b.score * 100).toFixed(0)}%`;
      ctx.font = "600 12px system-ui";
      const tw = ctx.measureText(text).width + 10;
      ctx.fillStyle = col + "dd";
      ctx.fillRect(x, Math.max(0, y - 20), tw, 20);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, x + 5, Math.max(14, y - 6));
    }
  }, [boxes, lineX, showLine, live, invert]);

  const snapshot = async (important = false) => {
    setBusy(true);
    try {
      const a = await captureAsset();
      const people = boxes.filter((b) => b.cls === "person").length;
      await postEvent({
        type: important ? "manual" : "snapshot",
        label: important ? `Đánh dấu quan trọng – ${cam.name}` : `Ảnh chụp nhanh – ${cam.name}${detect ? ` (${people} người)` : ""}`,
        assetId: a.id,
        priority: important ? "important" : "normal",
        tags: important ? ["quan trọng"] : ["ảnh chụp"],
        note: detect && boxes.length ? `Đối tượng (nhận diện trên trình duyệt, chưa xác minh): ${boxes.map((b) => b.label).join(", ")}` : undefined,
        clientReported: detect,
      });
      flash(important ? "Đã đánh dấu sự kiện quan trọng" : "Đã chụp & lưu vào trí nhớ");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Lỗi chụp ảnh");
    } finally {
      setBusy(false);
    }
  };

  const noteFromFrame = async () => {
    setBusy(true);
    try {
      const a = await captureAsset(1600);
      router.push(`/extract?asset=${a.id}`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Lỗi");
      setBusy(false);
    }
  };

  const toggleRecord = () => {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    if (!streamRef.current) return flash("Ghi clip trình duyệt chỉ hỗ trợ webcam; lưu RTSP cần Recorder phía máy chủ.");
    const chunks: Blob[] = [];
    const mr = new MediaRecorder(streamRef.current, { mimeType: MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : "" , videoBitsPerSecond: 900_000 });
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      setRecording(false);
      try {
        const blob = new Blob(chunks, { type: mr.mimeType || "video/webm" });
        const a = await uploadDataUrl(await blobToDataUrl(blob), { origin: "clip", cameraId: cam.id });
        await postEvent({ type: "clip", label: `Clip ghi hình – ${cam.name}`, assetId: a.id, tags: ["clip"] });
        flash("Đã lưu clip vào trí nhớ");
      } catch (e) {
        flash(e instanceof Error ? e.message : "Lỗi lưu clip");
      }
    };
    mr.start();
    recRef.current = mr;
    setRecording(true);
    setTimeout(() => mr.state === "recording" && mr.stop(), 15000);
  };

  const people = boxes.filter((b) => b.cls === "person").length;

  return (
    <div className="space-y-2">
      <div ref={wrapRef} className="relative aspect-video w-full overflow-hidden rounded-xl border border-cyan-400/20 bg-black">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {/* Webcam mất kết nối không hiển thị ảnh mẫu gây nhầm là camera đang hoạt động. */}
        {(isRtsp || cam.sourceType === "demo") && <img key={`${cam.id}-${streamRevision}`} ref={imgRef} src={isRtsp ? `/api/cameras/${cam.id}/stream` : (cam.thumbnail ?? "/cams/cam1.jpg")}
          onLoad={isRtsp ? () => setStreamState("live") : undefined} onError={isRtsp ? () => setStreamState("lost") : undefined}
          alt={`${cam.name} – ${cam.location}`} className="absolute inset-0 h-full w-full object-cover" />}
        {isWebcam && !live && <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-300">Webcam chưa kết nối · không có hình ảnh trực tiếp</div>}
        <video ref={videoRef} muted playsInline className={`absolute inset-0 h-full w-full object-cover ${isWebcam && live ? "" : "hidden"}`} />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />

        <div className="absolute left-3 top-3 flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-lg bg-black/60 px-2.5 py-1 text-sm font-semibold backdrop-blur">
            <Video className="h-4 w-4 text-cyan-300" /> {cam.name} – {cam.location}
          </span>
          <span className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-semibold ${streamState === "live" ? "bg-emerald-500/80" : streamState === "lost" ? "bg-rose-500/80" : "bg-slate-600/80"}`}>
            <span className={`h-1.5 w-1.5 rounded-full bg-white ${streamState === "live" ? "live-dot" : ""}`} />
            {streamBadge(cam.sourceType, streamState)}
          </span>
          {streamState === "lost" && (
            <button onClick={isRtsp ? reconnectIp : startWebcam} className="rounded-lg bg-white/90 px-2 py-1 text-xs font-semibold text-slate-900">Kết nối lại</button>
          )}
          {recording && <span className="flex items-center gap-1 rounded-lg bg-red-600/90 px-2 py-1 text-xs font-bold"><Circle className="h-2.5 w-2.5 fill-white anim-blink-fast" /> REC</span>}
        </div>
        {detect && (
          <div className="absolute right-3 top-3 rounded-lg bg-black/60 px-2 py-1 text-xs backdrop-blur">
            {detState === "loading" ? <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Đang kết nối nhận diện hình ảnh…</span> : <>Đang thấy: <b className="text-emerald-300">{people}</b> người · {boxes.length} đối tượng</>}
          </div>
        )}
        {now && <div className="absolute bottom-3 left-3 rounded-lg bg-black/60 px-2.5 py-1 font-mono text-sm backdrop-blur">{now.toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} – {now.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</div>}

        <div className="absolute bottom-3 right-3 flex gap-1.5">
          {isWebcam && (
            <button onClick={live ? stopWebcam : startWebcam} className="rounded-lg bg-black/60 p-2 backdrop-blur hover:bg-cyan-600/60" aria-label={live ? "Tắt webcam" : "Bật webcam"} title={live ? "Tắt webcam" : "Bật webcam"}>
              {live ? <VideoOff className="h-4 w-4" /> : <Video className="h-4 w-4" />}
            </button>
          )}
          <button onClick={() => setDetect((d) => !d)} className={`rounded-lg p-2 backdrop-blur ${detect ? "bg-cyan-500/70" : "bg-black/60 hover:bg-cyan-600/60"}`} aria-label="Bật/tắt nhận diện" title="Bật/tắt nhận diện AI">
            <ScanEye className="h-4 w-4" />
          </button>
          <button onClick={() => snapshot(false)} disabled={busy} className="rounded-lg bg-black/60 p-2 backdrop-blur hover:bg-cyan-600/60" aria-label="Chụp ảnh" title="Chụp ảnh">
            <CamIcon className="h-4 w-4" />
          </button>
          {onSettings && (
            <button onClick={onSettings} data-settings-frame={cam.id} className="rounded-lg bg-black/60 p-2 backdrop-blur hover:bg-cyan-600/60" aria-label="Cài đặt camera" title="Cài đặt">
              <Settings className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            data-fs-toggle
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Thu nhỏ" : "Phóng to"}
            title={isFullscreen ? "Thoát toàn màn hình" : "Toàn màn hình"}
            className="rounded-lg bg-black/60 p-2 backdrop-blur hover:bg-cyan-600/60"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
        {toast && <div className="anim-fadeup absolute left-1/2 top-14 -translate-x-1/2 rounded-xl bg-cyan-600/90 px-4 py-2 text-sm font-medium shadow-lg">{toast}</div>}
        {isWebcam && !live && (
          <button onClick={startWebcam} className="btn btn-primary absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 shadow-2xl">
            <Video className="h-4 w-4" /> Bật webcam trực tiếp
          </button>
        )}
      </div>

      {!compact && (
        <>
          {isWebcam && <div className="glass flex flex-wrap items-center gap-2 rounded-xl p-3 text-sm">
            <label htmlFor="webcam-device">Webcam USB / tích hợp:</label>
            <select id="webcam-device" className="input min-w-48 flex-1" value={selectedDeviceId} onChange={(e) => {
              setSelectedDeviceId(e.target.value); window.localStorage.setItem("dai_webcam_device", e.target.value);
              stopWebcam();
            }}>
              {devices.length ? devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Webcam ${i+1}`}</option>) : <option value="">Chưa cấp quyền hoặc chưa tìm thấy webcam</option>}
            </select>
            <button className="btn btn-ghost" onClick={startWebcam}><RefreshCw className="h-4 w-4"/> Kết nối</button>
          </div>}
          {isRtsp && <div className="glass flex items-center justify-between gap-3 rounded-xl p-3 text-xs text-slate-300">
            <span>Camera IP qua go2rtc · Hình ảnh thật chỉ hiện khi đường RTSP hoạt động.</span>
            <button onClick={reconnectIp} className="btn btn-ghost"><RefreshCw className="h-4 w-4"/> Kết nối lại</button>
          </div>}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => snapshot(false)} disabled={busy} className="btn btn-ghost"><CamIcon className="h-4 w-4" /> Chụp ảnh</button>
            <button onClick={toggleRecord} disabled={!isWebcam || !live} title={isWebcam ? (live ? "" : "Cần bật webcam") : "Cần bật ghi hình trên máy chủ"} className={`btn ${recording ? "btn-danger" : "btn-ghost"}`}>
              {recording ? <Square className="h-4 w-4" /> : <Circle className="h-4 w-4 text-red-400" />} {recording ? "Dừng ghi" : isWebcam ? "Ghi clip" : "Ghi clip (sắp có)"}
            </button>
            <button onClick={() => snapshot(true)} disabled={busy} className="btn btn-ghost"><Star className="h-4 w-4 text-amber-300" /> Đánh dấu quan trọng</button>
            <button onClick={noteFromFrame} disabled={busy} className="btn btn-ghost"><NotebookPen className="h-4 w-4 text-cyan-300" /> Tạo ghi chú từ khung hình</button>
            <button onClick={() => setDetect((d) => !d)} className={`btn ${detect ? "btn-primary" : "btn-ghost"}`}><ScanEye className="h-4 w-4" /> Nhận diện: {detect ? "Bật" : "Tắt"}</button>
          </div>
          {isWebcam && (
            <div className="glass flex flex-wrap items-center gap-4 rounded-xl px-4 py-3 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={showLine} onChange={(e) => setShowLine(e.target.checked)} className="accent-cyan-400" /> Đường đếm</label>
              <label className="flex flex-1 items-center gap-2 text-slate-300">Vị trí
                <input type="range" min={0.15} max={0.85} step={0.01} value={lineX} onChange={(e) => setLineX(Number(e.target.value))} className="flex-1 accent-cyan-400" aria-label="Vị trí đường đếm" />
              </label>
              <button onClick={() => setInvert((v) => !v)} className="btn btn-ghost py-1"><ArrowLeftRight className="h-4 w-4" /> Đảo hướng</button>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-lg bg-cyan-500/15 px-2 py-1 text-cyan-200" title="Số đối tượng đang thấy trong khung hình hiện tại (ước lượng quan sát)">Đang thấy: <b>{people}</b> người</span>
                <span className="rounded-lg bg-emerald-500/15 px-2 py-1 text-emerald-300" title="Số lượt đi qua vạch trong phiên này">Lượt vào: <b>{counts.in}</b></span>
                <span className="rounded-lg bg-sky-500/15 px-2 py-1 text-sky-300" title="Số lượt đi ra trong phiên này">Lượt ra: <b>{counts.out}</b></span>
                <span className="rounded-lg bg-violet-500/15 px-2 py-1 text-violet-200" title="Chênh lệch vào − ra, không phải số người duy nhất">Ước tính bên trong: <b>{Math.max(0, counts.in - counts.out)}</b></span>
              </div>
              <p className="w-full text-[11px] text-slate-400">Đếm khi người đi qua vạch (vùng trễ ±3%, ổn định 2 khung, chống lặp 3 giây/track, khóa idempotency theo phiên). Mỗi lượt lưu kèm ảnh bằng chứng và được đánh dấu <b>“client báo · chưa xác minh”</b> cho tới khi bạn duyệt.{!live && " Bật webcam và nhận diện để đếm thử; không thay thế engine camera chạy nền."}</p>
            </div>
          )}
        </>
      )}

    </div>
  );
}
