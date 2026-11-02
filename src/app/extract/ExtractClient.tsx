"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Camera, UploadCloud, Crop, X, ZoomIn, ZoomOut, Sparkles, Loader2, CheckCircle2, Save, Link2, Ban, RotateCcw, RotateCw, Scissors, Columns2, Download, Tag, AlertTriangle, History, ImageIcon,
} from "lucide-react";
import { api, drawToCanvas, fileToDataUrl, getDeviceId, uploadDataUrl, type Roi } from "@/lib/client";
import type { ExtractionResult } from "@/db/schema";
import { Badge, Modal } from "@/components/ui";
import { useApp } from "@/components/AppState";
import JobProgress from "@/components/JobProgress";
import { waitForJob } from "@/lib/ai/client";
import type { JobView } from "@/lib/ai/types";
import Link from "next/link";

type Status = "DRAFT" | "EMPTY" | "IMAGE_READY" | "ANNOTATED" | "PROCESSING" | "REVIEW_REQUIRED" | "VERIFIED" | "SAVED" | "FAILED";
type ExRow = { id: number; assetId: number; title: string; note: string; roi: Roi | null; taskType: string; status: string; result: ExtractionResult | null; rawResult: ExtractionResult | null; memoryType: string; tags: string[]; eventId: number | null; version: number; createdAt: string; thumb: string | null; productName?: string | null; sku?: string | null; priceVnd?: number | null; quantity?: number | null };

const TEMPLATES = [
  { t: "Trích xuất biển số xe", type: "plate" },
  { t: "Tìm số người trong ảnh", type: "object_count" },
  { t: "Mô tả các vật thể trên bàn", type: "describe" },
  { t: "Lấy thông tin từ bảng giấy / phiếu", type: "ocr" },
  { t: "Cho biết người này mang gì (túi, ba lô, điện thoại…)", type: "object_count" },
  { t: "Xác định màu áo chủ đạo, số người, đồ vật mang theo", type: "freeform" },
];

const TASKS: [string, string][] = [
  ["freeform", "Tự do"],
  ["object_count", "Đếm đối tượng"],
  ["ocr", "OCR văn bản"],
  ["plate", "Biển số xe"],
  ["describe", "Mô tả ảnh"],
];

const STATUS_LABEL: Record<Status, [string, string]> = {
  DRAFT: ["Đã lưu ghi chú · chưa chạy AI", "teal"],
  EMPTY: ["Chưa có ảnh", "slate"],
  IMAGE_READY: ["Ảnh sẵn sàng", "cyan"],
  ANNOTATED: ["Đã chọn vùng", "violet"],
  PROCESSING: ["Đang xử lý", "indigo"],
  REVIEW_REQUIRED: ["Cần xác nhận", "amber"],
  VERIFIED: ["Đã xác minh", "emerald"],
  SAVED: ["Đã lưu tạm", "teal"],
  FAILED: ["Thất bại / Sai", "orange"],
};

function download(name: string, content: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function ExtractClient() {
  const params = useSearchParams();
  const { setMood } = useApp();
  const [assetId, setAssetId] = useState<number | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [fileName, setFileName] = useState("");
  const [roi, setRoi] = useState<Roi | null>(null);
  const [roiMode, setRoiMode] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [compare, setCompare] = useState(false);
  const [title, setTitle] = useState("");
  const [taskType, setTaskType] = useState("freeform");
  const [note, setNote] = useState("");
  const [productName, setProductName] = useState("");
  const [sku, setSku] = useState("");
  const [priceVnd, setPriceVnd] = useState("");
  const [quantity, setQuantity] = useState("");
  const [status, setStatus] = useState<Status>("EMPTY");
  const [progress, setProgress] = useState("");
  const [job, setJob] = useState<JobView | null>(null);
  const [remoteAllowed, setRemoteAllowed] = useState(false);
  const [allowRemote, setAllowRemote] = useState(false);
  const pollRef = useRef<AbortController | null>(null);
  const [ex, setEx] = useState<ExRow | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [tab, setTab] = useState<"summary" | "objects" | "ocr" | "structured" | "json">("summary");
  const [tags, setTags] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<ExRow[]>([]);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [pulseUpload, setPulseUpload] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const camFileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const loadHistory = useCallback(() => api<ExRow[]>("/api/extractions").then(setHistory).catch(() => {}), []);

  useEffect(() => {
    loadHistory();
    api<{ settings: { remoteProcessingAllowed: boolean } }>("/api/settings").then((r) => setRemoteAllowed(r.settings.remoteProcessingAllowed)).catch(() => {});
    const pendingJob = params.get("job");
    if (pendingJob) void followJob(pendingJob);
    // Never reuse another image’s note. Each image has its own draft key.
    const key = `dai_note_draft_${params.get("asset") || "new"}`;
    const draft = localStorage.getItem(key);
    if (draft) setNote(draft);
    const a = params.get("asset");
    if (a) {
      setAssetId(Number(a));
      setImgUrl(`/api/assets/${a}`);
      setFileName(`asset #${a}`);
      setStatus("IMAGE_READY");
    }
    if (params.get("mode") === "capture") setCaptureOpen(true);
    if (params.get("mode") === "upload") setPulseUpload(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(`dai_note_draft_${assetId ?? "new"}`, note.slice(0, 2000)), 400);
    return () => clearTimeout(t);
  }, [note, assetId]);

  // capture modal webcam
  useEffect(() => {
    if (!captureOpen) return;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        streamRef.current = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          videoRef.current.play();
        }
      })
      .catch(() => {
        setCaptureOpen(false);
        camFileRef.current?.click();
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [captureOpen]);

  useEffect(() => () => { pollRef.current?.abort(); }, []);

  const resetForNewImage = () => {
    pollRef.current?.abort();
    setJob(null);
    setAssetId(null);
    setNote(""); setTitle(""); setTags("");
    setProductName(""); setSku(""); setPriceVnd(""); setQuantity("");
    setRoi(null);
    setEx(null);
    setResult(null);
    setErr(null);
    setZoom(1);
  };

  const ingest = async (dataUrl: string, w: number, h: number, name: string, origin: string) => {
    resetForNewImage();
    setImgUrl(dataUrl);
    setDims({ w, h });
    setFileName(name);
    setStatus("IMAGE_READY");
    try {
      const r = await uploadDataUrl(dataUrl, { width: w, height: h, origin });
      setAssetId(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Tải ảnh thất bại");
      setStatus("FAILED");
    }
  };

  const onFile = async (f: File | undefined, origin = "upload") => {
    if (!f) return;
    try {
      const { dataUrl, width, height } = await fileToDataUrl(f);
      await ingest(dataUrl, width, height, f.name, origin);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không đọc được ảnh");
    }
  };

  const reingestCanvas = async (c: HTMLCanvasElement, name: string) => {
    resetForNewImage();
    setImgUrl(c.toDataURL("image/jpeg", 0.92));
    setDims({ w: c.width, h: c.height });
    setFileName(name);
    setStatus("IMAGE_READY");
    const r = await uploadDataUrl(c.toDataURL("image/jpeg", 0.92), { width: c.width, height: c.height, origin: "capture" });
    setAssetId(r.id);
  };

  const rotate = async () => {
    const img = imgRef.current;
    if (!img) return;
    const base = drawToCanvas(img, img.naturalWidth, img.naturalHeight, 1600);
    const out = document.createElement("canvas");
    out.width = base.height;
    out.height = base.width;
    const ctx = out.getContext("2d")!;
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(base, -base.width / 2, -base.height / 2);
    await reingestCanvas(out, `xoay-${fileName || "anh"}.jpg`);
  };

  const cropRoi = async () => {
    const img = imgRef.current;
    if (!img || !roi) return;
    const out = drawToCanvas(img, img.naturalWidth, img.naturalHeight, 1600, roi);
    await reingestCanvas(out, `crop-${fileName || "anh"}.jpg`);
    setRoi(null);
  };

  const takePhoto = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = drawToCanvas(v, v.videoWidth, v.videoHeight, 1600);
    setCaptureOpen(false);
    await ingest(c.toDataURL("image/jpeg", 0.9), c.width, c.height, `chup_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jpg`, "capture");
  };

  // ROI drawing
  const rel = (e: React.PointerEvent) => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (!roiMode) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = rel(e);
    setDrag(p);
    setRoi({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = rel(e);
    setRoi({ x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) });
  };
  const onUp = () => {
    if (!drag) return;
    setDrag(null);
    setRoiMode(false);
    setRoi((r) => {
      if (!r || r.w < 0.02 || r.h < 0.02) return null;
      setStatus((s) => (s === "IMAGE_READY" ? "ANNOTATED" : s));
      return r;
    });
  };

  const followJob = async (id: string) => {
    pollRef.current?.abort();
    const controller = new AbortController();
    pollRef.current = controller;
    setStatus("PROCESSING"); setMood("thinking");
    try {
      const envelope = await waitForJob<ExRow>(id, (current) => {
        setJob(current);
        setProgress(current.steps.find((s) => s.state === "running")?.label ?? "Đang chờ AI Worker…");
      }, controller.signal);
      if (controller.signal.aborted) return;
      const row = envelope.extraction;
      if (row) {
        setAssetId(row.assetId);
        setImgUrl(`/api/assets/${row.assetId}`);
        setNote(row.note); setTitle(row.title); setRoi(row.roi); setTaskType(row.taskType);
        setProductName(row.productName || ""); setSku(row.sku || ""); setPriceVnd(row.priceVnd == null ? "" : String(row.priceVnd)); setQuantity(row.quantity == null ? "" : String(row.quantity));
        setEx({ ...row, thumb: `/api/assets/${row.assetId}` });
      }
      if (["succeeded", "partial"].includes(envelope.job.state) && row?.result) {
        setResult(row.result); setStatus(row.status === "VERIFIED" ? "VERIFIED" : row.status === "FAILED" ? "FAILED" : "REVIEW_REQUIRED"); setTab("summary"); setErr(row.status === "FAILED" ? "Kết quả này đã bị đánh dấu sai." : null);
      } else {
        setStatus("FAILED"); setErr(envelope.job.error ?? "Worker chưa hoàn tất. Ảnh và ghi chú đã được giữ lại.");
      }
      loadHistory();
    } catch (e) {
      if (!controller.signal.aborted) { setErr(e instanceof Error ? e.message : "Không theo dõi được tác vụ"); setStatus("FAILED"); }
    } finally {
      if (!controller.signal.aborted) { setProgress(""); setMood("idle"); }
    }
  };

  const extract = async () => {
    if (!assetId || status === "PROCESSING") return;
    if (!note.trim()) return setErr("Hãy nhập ghi chú yêu cầu bên cạnh ảnh.");
    setErr(null); setResult(null); setStatus("PROCESSING"); setMood("thinking");
    setProgress("Gateway đang tiếp nhận yêu cầu…");
    try {
      const response = await api<{ job: JobView }>("/api/extractions", { method: "POST",
        json: { assetId, note, roi, taskType, title, productName, sku, priceVnd, quantity, allowRemote, requestId: crypto.randomUUID(), tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } });
      setJob(response.job);
      await followJob(response.job.id);
    } catch (e) { setErr(e instanceof Error ? e.message : "Không gửi được tác vụ"); setStatus("FAILED"); setMood("idle"); setProgress(""); }
  };

  const saveDraft = async () => {
    if (!assetId || !note.trim() || status === "PROCESSING") return;
    setErr(null);
    try {
      const row = await api<ExRow>("/api/extractions", { method: "POST", json: { action: "draft", assetId, note, title, roi, taskType, productName, sku, priceVnd, quantity, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } });
      setEx(row); setResult(null); setStatus("DRAFT"); loadHistory();
    } catch (e) { setErr(e instanceof Error ? e.message : "Không lưu được ghi chú"); }
  };

  const act = async (action: "verify" | "temporary" | "reject" | "attach") => {
    if (!ex || !result) return;
    const body: Record<string, unknown> = { result, title: title || ex.title, productName, sku, priceVnd, quantity, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), deviceId: getDeviceId() };
    if (action === "attach") body.attachEvent = true;
    else body.action = action;
    try {
      const row = await api<ExRow>(`/api/extractions/${ex.id}`, { method: "PATCH", json: body });
      setEx({ ...ex, ...row });
      if (action === "verify") setStatus("VERIFIED");
      else if (action === "temporary") setStatus("SAVED");
      else if (action === "reject") setStatus("FAILED");
      loadHistory();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Lỗi lưu");
    }
  };

  const openHistory = (h: ExRow) => {
    pollRef.current?.abort(); setJob(null); setProgress("");
    setErr(h.status === "PROCESSING" ? "Ảnh này có tác vụ đang chạy. Mở Điều phối AI để tiếp tục theo dõi." : null);
    setAssetId(h.assetId);
    setImgUrl(h.thumb);
    setDims(null);
    setFileName(h.title);
    setRoi(h.roi);
    setNote(h.note);
    setProductName(h.productName || ""); setSku(h.sku || "");
    setPriceVnd(h.priceVnd == null ? "" : String(h.priceVnd));
    setQuantity(h.quantity == null ? "" : String(h.quantity));
    setTitle(h.title);
    setTaskType(h.taskType);
    setTags(h.tags.join(", "));
    setEx(h);
    setResult(h.result);
    setStatus(h.status === "PROCESSING" ? "IMAGE_READY" : h.status === "DRAFT" ? "DRAFT" : h.status === "VERIFIED" ? "VERIFIED" : h.status === "FAILED" ? "FAILED" : h.memoryType === "temporary" && h.version > 1 ? "SAVED" : "REVIEW_REQUIRED");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const upd = (patch: Partial<ExtractionResult>) => result && setResult({ ...result, ...patch });

  // detection boxes in full-image coordinates
  const r0 = ex?.roi ?? roi;
  const boxes = (result?.objects ?? []).flatMap((o) =>
    (o.boxes ?? []).map((b) => ({ label: o.label, x: (r0?.x ?? 0) + b[0] * (r0?.w ?? 1), y: (r0?.y ?? 0) + b[1] * (r0?.h ?? 1), w: b[2] * (r0?.w ?? 1), h: b[3] * (r0?.h ?? 1) }))
  );
  const [sl, sc] = STATUS_LABEL[status];
  const canEdit = !!result && status !== "PROCESSING";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Ảnh & Trích xuất</h1>
        <span className="rounded-full border border-cyan-400/20 px-2 py-1 text-[10px] text-cyan-200">Gateway → AI Workers · không tải model</span>
        <Badge color={sc}>{sl}</Badge>
        <div className="ml-auto hidden items-center gap-1 text-[11px] text-slate-400 md:flex">
          {(["EMPTY", "IMAGE_READY", "ANNOTATED", "PROCESSING", "REVIEW_REQUIRED", "VERIFIED"] as Status[]).map((s, i) => (
            <span key={s} className={`rounded px-1.5 py-0.5 ${s === status ? "bg-cyan-500/25 text-cyan-200" : ""}`}>{i > 0 && "→ "}{STATUS_LABEL[s][0]}</span>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* LEFT: image */}
        <section className="glass flex flex-col gap-3 rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Ảnh đầu vào</h2>
            <div className="flex gap-1">
              <button onClick={() => setZoom((z) => Math.max(1, z - 0.5))} disabled={!imgUrl || zoom <= 1} className="rounded-lg p-1.5 hover:bg-white/10 disabled:opacity-30" aria-label="Thu nhỏ"><ZoomOut className="h-4 w-4" /></button>
              <span className="w-10 text-center text-xs leading-7 text-slate-400">{zoom}x</span>
              <button onClick={() => setZoom((z) => Math.min(3, z + 0.5))} disabled={!imgUrl || status === "PROCESSING"} className="rounded-lg p-1.5 hover:bg-white/10 disabled:opacity-30" aria-label="Phóng to"><ZoomIn className="h-4 w-4" /></button>
            </div>
          </div>
          <div className="scroll-thin relative max-h-[60vh] min-h-[260px] overflow-auto rounded-xl border border-dashed border-cyan-400/30 bg-black/40">
            {imgUrl ? (
              <div className="relative mx-auto" style={{ width: `${zoom * 100}%` }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={imgUrl}
                  alt="Ảnh cần trích xuất"
                  className="block w-full select-none"
                  draggable={false}
                  onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                />
                <div className={`absolute inset-0 ${roiMode ? "cursor-crosshair" : ""}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
                  {boxes.map((b, i) => (
                    <div key={i} className="pointer-events-none absolute border-2 border-emerald-400" style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}>
                      <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-emerald-500/90 px-1 text-[10px] font-semibold">{b.label}</span>
                    </div>
                  ))}
                  {roi && (
                    <div className="pointer-events-none absolute border-2 border-dashed border-cyan-300 bg-cyan-300/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" style={{ left: `${roi.x * 100}%`, top: `${roi.y * 100}%`, width: `${roi.w * 100}%`, height: `${roi.h * 100}%` }}>
                      <span className="absolute -top-5 left-0 rounded bg-cyan-500 px-1 text-[10px] font-bold">Vùng quan tâm</span>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-[260px] flex-col items-center justify-center gap-3 text-slate-400">
                <ImageIcon className="h-12 w-12 text-cyan-400/50" />
                <p className="text-sm">Chụp ảnh hoặc tải ảnh lên để bắt đầu</p>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button disabled={status === "PROCESSING"} onClick={() => setCaptureOpen(true)} className="btn btn-primary"><Camera className="h-4 w-4" /> Chụp ảnh</button>
            <button disabled={status === "PROCESSING"} onClick={() => { setPulseUpload(false); fileRef.current?.click(); }} className={`btn btn-ghost ${pulseUpload ? "neon-ring anim-pulse-soft" : ""}`}><UploadCloud className="h-4 w-4" /> Tải ảnh lên</button>
            <button onClick={() => setRoiMode((m) => !m)} disabled={!imgUrl || status === "PROCESSING"} className={`btn ${roiMode ? "btn-primary" : "btn-ghost"}`}><Crop className="h-4 w-4" /> {roiMode ? "Kéo để chọn vùng…" : "Chọn vùng"}</button>
            <button onClick={rotate} disabled={!imgUrl || status === "PROCESSING"} className="btn btn-ghost" title="Xoay 90°"><RotateCw className="h-4 w-4" /> Xoay</button>
            <button onClick={cropRoi} disabled={!roi || status === "PROCESSING"} className="btn btn-ghost" title={roi ? "Cắt theo vùng chọn" : "Chọn vùng trước"}><Scissors className="h-4 w-4" /> Cắt vùng</button>
            <button onClick={() => setCompare((c) => !c)} disabled={!ex} className={`btn ${compare ? "btn-primary" : "btn-ghost"}`}><Columns2 className="h-4 w-4" /> So sánh</button>
            {roi && <button onClick={() => { setRoi(null); setStatus((s) => (s === "ANNOTATED" ? "IMAGE_READY" : s)); }} className="btn btn-ghost"><X className="h-4 w-4" /> Bỏ vùng</button>}
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
            <input ref={camFileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { onFile(e.target.files?.[0], "capture"); e.target.value = ""; }} />
          </div>
          <div className="text-xs text-slate-400">
            {fileName ? <>Tệp: <span className="text-slate-200">{fileName}</span>{dims && <> · {dims.w}×{dims.h}</>}{assetId && <> · Asset #{assetId}</>}{roi && <> · Vùng: {(roi.w * 100).toFixed(0)}%×{(roi.h * 100).toFixed(0)}%</>}</> : "JPEG/PNG/WEBP, tối đa 25 MB. Ảnh được băm SHA-256 và lưu vào trí nhớ."}
          </div>
        </section>

        {/* RIGHT: note + results */}
        <section className="glass flex flex-col gap-3 rounded-2xl p-4">
          <h2 className="font-semibold">Ghi chú / Chỉ dẫn trích xuất</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Tên tác vụ (vd: Kiểm kê hàng)" className="input" aria-label="Tên tác vụ" />
            <select value={taskType} onChange={(e) => setTaskType(e.target.value)} className="input" aria-label="Loại trích xuất">
              {TASKS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <details className="rounded-xl border border-cyan-400/15 bg-cyan-500/5 p-3" open>
            <summary className="cursor-pointer text-sm font-semibold">Thông tin sản phẩm riêng cho ảnh này (tùy chọn)</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input className="input" value={productName} maxLength={120} onChange={(e)=>setProductName(e.target.value)} placeholder="Tên sản phẩm" aria-label="Tên sản phẩm riêng cho ảnh" />
              <input className="input" value={sku} maxLength={80} onChange={(e)=>setSku(e.target.value)} placeholder="Mã SKU" aria-label="SKU riêng cho ảnh" />
              <input className="input" inputMode="numeric" value={priceVnd} onChange={(e)=>setPriceVnd(e.target.value)} placeholder="Giá bán VNĐ, ví dụ 150000" aria-label="Giá bán VNĐ" />
              <input className="input" inputMode="numeric" value={quantity} onChange={(e)=>setQuantity(e.target.value)} placeholder="Số lượng, ví dụ 20" aria-label="Số lượng trong ghi chú" />
            </div>
            <p className="mt-2 text-[11px] text-slate-400">Dữ liệu do người dùng nhập, lưu theo bản ghi ảnh. AI không tự sửa giá hay số lượng.</p>
          </details>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} className="input" placeholder="Ví dụ: Trích xuất biển số xe, màu áo, số người, đồ vật mang theo…" aria-label="Ghi chú yêu cầu" />
          <div className="flex flex-wrap gap-1.5">
            {TEMPLATES.map((t) => (
              <button key={t.t} onClick={() => { setNote(t.t); setTaskType(t.type); }} className="rounded-full border border-cyan-400/20 bg-cyan-500/5 px-2.5 py-1 text-[11px] text-cyan-100 hover:bg-cyan-500/15">{t.t}</button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-slate-400" />
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Gắn thẻ: kho, xe, khách…" className="input py-1.5" aria-label="Thẻ" />
          </div>
          <p className="text-[11px] text-slate-400">Ghi chú là <b>hướng dẫn</b>, không phải sự thật: số liệu trong ghi chú không bao giờ được dùng làm kết quả.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={saveDraft} disabled={!assetId || !note.trim() || status === "PROCESSING"} className="btn btn-ghost text-xs"><Save className="h-4 w-4" /> Lưu ghi chú · không cần AI</button>
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400"><input type="checkbox" className="accent-cyan-400" checked={allowRemote} disabled={!remoteAllowed || status === "PROCESSING"} onChange={(e) => setAllowRemote(e.target.checked)} /> Cho phép gửi ảnh tới AI ngoài mạng riêng</label>
          </div>
          {!remoteAllowed && <p className="text-[10px] text-slate-500">AI ngoài mạng riêng đang tắt. Worker nội bộ vẫn có thể xử lý ảnh.</p>}
          <button onClick={extract} disabled={status === "PROCESSING" || !assetId} className="btn btn-primary py-3 text-base">
            {status === "PROCESSING" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
            {status === "PROCESSING" ? progress || "Đang xử lý…" : result ? "Trích xuất lại" : "Trích xuất"}
          </button>
          {job && <JobProgress job={job} compact onUpdate={(updated) => { setJob(updated); if (updated.state === "queued") void followJob(updated.id); }} />}
          {status === "FAILED" && <Link href="/orchestration" className="text-xs text-cyan-300 hover:underline">Kiểm tra Hermes / AI Workers →</Link>}
          {err && <div className="flex gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{err}</div>}

          {result && (
            <div className="anim-fadeup space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">Kết quả</span>
                <span className="text-xs text-slate-400">v{ex?.version ?? 1} · {result.engine.join(" + ") || "—"}</span>
                <div className="ml-auto flex items-center gap-2 text-xs">
                  Tin cậy
                  <div className="h-2 w-20 overflow-hidden rounded-full bg-white/10"><div className={`h-full ${result.confidence >= 0.75 ? "bg-emerald-400" : result.confidence >= 0.5 ? "bg-amber-400" : "bg-orange-500"}`} style={{ width: `${result.confidence * 100}%` }} /></div>
                  <b>{Math.round(result.confidence * 100)}%</b>
                </div>
              </div>
              <div className="scroll-thin flex gap-1 overflow-x-auto">
                {([["summary", "Tóm tắt"], ["objects", `Đối tượng (${result.objects.length})`], ["ocr", "Văn bản OCR"], ["structured", `Cấu trúc (${result.structured.length})`], ["json", "JSON"]] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setTab(k)} className={`shrink-0 rounded-lg px-2.5 py-1 text-xs ${tab === k ? "bg-cyan-500/25 text-cyan-100" : "text-slate-400 hover:bg-white/5"}`}>{l}</button>
                ))}
              </div>
              {compare && ex?.rawResult && (
                <div className="grid gap-2 rounded-xl border border-cyan-400/20 bg-black/30 p-2 text-xs md:grid-cols-2">
                  <div>
                    <div className="mb-1 font-semibold text-cyan-200">AI quan sát ban đầu</div>
                    <p className="text-slate-300">{ex.rawResult.summary}</p>
                    <div className="mt-1 text-[11px] text-[#a9bad2]">Tin cậy {Math.round(ex.rawResult.confidence * 100)}% · {ex.rawResult.objects.map((o) => `${o.label}: ${o.count}`).join(", ") || "không có đối tượng"}</div>
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-amber-200">Bản hiện tại (có thể đã sửa)</div>
                    <p className="text-slate-200">{result.summary}</p>
                    <div className="mt-1 text-[11px] text-[#a9bad2]">Tin cậy {Math.round(result.confidence * 100)}% · {result.objects.map((o) => `${o.label}: ${o.count}${o.edited ? " (sửa)" : ""}`).join(", ") || "không có đối tượng"}</div>
                  </div>
                  <p className="md:col-span-2 text-[11px] text-amber-200">Bản ghi AI gốc luôn được giữ trong “rawResult”; dữ liệu bạn sửa được đánh dấu ĐÃ SỬA và tăng version.</p>
                </div>
              )}
              {tab === "summary" && (
                <div className="space-y-2">
                  <textarea value={result.summary} onChange={(e) => upd({ summary: e.target.value })} disabled={!canEdit} rows={3} className="input text-sm" aria-label="Tóm tắt" />
                  {result.details.length > 0 && <ul className="space-y-0.5 text-[13px] text-slate-300">{result.details.map((d, i) => <li key={i}>• {d}</li>)}</ul>}
                </div>
              )}
              {tab === "objects" && (
                <div className="space-y-1.5">
                  {result.objects.map((o, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span className={`shrink-0 rounded px-1 text-[9px] font-semibold ${o.edited ? "bg-amber-400/20 text-amber-200" : "bg-cyan-400/15 text-cyan-200"}`}>{o.edited ? "ĐÃ SỬA" : "AI"}</span>
                      <input value={o.label} onChange={(e) => upd({ objects: result.objects.map((x, j) => (j === i ? { ...x, label: e.target.value, edited: true } : x)) })} className="input py-1" aria-label="Nhãn" />
                      <input type="number" min={0} value={o.count} onChange={(e) => upd({ objects: result.objects.map((x, j) => (j === i ? { ...x, count: Math.max(0, Number(e.target.value)), confidence: 1, edited: true } : x)) })} className="input w-20 py-1" aria-label="Số lượng" />
                      <span className="w-12 text-right text-xs text-slate-400">{Math.round(o.confidence * 100)}%</span>
                      <button onClick={() => upd({ objects: result.objects.filter((_, j) => j !== i) })} className="p-1 text-slate-500 hover:text-red-300" aria-label="Xóa"><X className="h-4 w-4" /></button>
                    </div>
                  ))}
                  <button onClick={() => upd({ objects: [...result.objects, { label: "đối tượng mới", count: 1, confidence: 1, edited: true }] })} className="text-xs text-cyan-300 hover:underline">+ Thêm đối tượng thủ công</button>
                </div>
              )}
              {tab === "ocr" && <textarea value={result.ocrText} onChange={(e) => upd({ ocrText: e.target.value })} rows={6} className="input font-mono text-xs" placeholder="(Không có văn bản — chọn loại “OCR văn bản” hoặc ghi chú yêu cầu đọc chữ)" aria-label="Văn bản OCR" />}
              {tab === "structured" && (
                <div className="space-y-1.5">
                  {result.structured.map((s, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className={`shrink-0 rounded px-1 text-[9px] font-semibold ${s.edited ? "bg-amber-400/20 text-amber-200" : "bg-cyan-400/15 text-cyan-200"}`}>{s.edited ? "ĐÃ SỬA" : "AI"}</span>
                      <input value={s.key} onChange={(e) => upd({ structured: result.structured.map((x, j) => (j === i ? { ...x, key: e.target.value, edited: true } : x)) })} className="input w-2/5 py-1 text-sm" aria-label="Trường" />
                      <input value={s.value} onChange={(e) => upd({ structured: result.structured.map((x, j) => (j === i ? { ...x, value: e.target.value, confidence: 1, edited: true } : x)) })} className="input py-1 text-sm" aria-label="Giá trị" />
                      <button onClick={() => upd({ structured: result.structured.filter((_, j) => j !== i) })} className="p-1 text-slate-500 hover:text-red-300" aria-label="Xóa"><X className="h-4 w-4" /></button>
                    </div>
                  ))}
                  <button onClick={() => upd({ structured: [...result.structured, { key: "Trường mới", value: "", confidence: 1, edited: true }] })} className="text-xs text-cyan-300 hover:underline">+ Thêm trường</button>
                </div>
              )}
              {tab === "json" && <pre className="scroll-thin max-h-60 overflow-auto rounded-lg bg-black/40 p-2 text-[11px] text-cyan-100">{JSON.stringify(result, null, 2)}</pre>}

              {result.warnings.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">Cần người dùng xác nhận</div>
                  {result.warnings.map((w, i) => <div key={i} className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-100"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{w}</div>)}
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <button onClick={() => act("verify")} className="btn btn-primary"><CheckCircle2 className="h-4 w-4" /> Xác nhận · Lưu đã xác minh</button>
                <button onClick={() => act("temporary")} className="btn btn-ghost"><Save className="h-4 w-4" /> Lưu ghi nhớ tạm</button>
                <button onClick={() => act("attach")} disabled={!!ex?.eventId} className="btn btn-ghost"><Link2 className="h-4 w-4" /> {ex?.eventId ? "Đã đính kèm sự kiện" : "Đính kèm vào sự kiện"}</button>
                <button onClick={() => act("reject")} className="btn btn-danger"><Ban className="h-4 w-4" /> Đánh dấu sai</button>
                <button onClick={extract} className="btn btn-ghost"><RotateCcw className="h-4 w-4" /> Thử lại</button>
                <button onClick={() => download(`trich-xuat-${ex?.id ?? "moi"}.json`, JSON.stringify({ id: ex?.id, assetId, note, roi, result }, null, 2), "application/json")} className="btn btn-ghost"><Download className="h-4 w-4" /> JSON</button>
                <button
                  onClick={() =>
                    download(
                      `trich-xuat-${ex?.id ?? "moi"}.csv`,
                      "\uFEFF" + ["loai,truong,gia_tri,tin_cay", ...result.objects.map((o) => `doi_tuong,"${o.label}",${o.count},${o.confidence}`), ...result.structured.map((s) => `cau_truc,"${s.key}","${s.value.replace(/"/g, '""')}",${s.confidence}`)].join("\n"),
                      "text/csv"
                    )
                  }
                  className="btn btn-ghost"
                >
                  <Download className="h-4 w-4" /> CSV
                </button>
              </div>
              {ex?.rawResult && JSON.stringify(ex.rawResult) !== JSON.stringify(result) && <p className="text-[11px] text-slate-400">Bạn đã chỉnh sửa kết quả. Bản gốc của AI vẫn được giữ nguyên làm bằng chứng.</p>}
            </div>
          )}
        </section>
      </div>

      <section className="glass rounded-2xl p-4">
        <h2 className="mb-3 flex items-center gap-2 font-semibold"><History className="h-4 w-4 text-cyan-300" /> Lịch sử trích xuất</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {history.map((h) => (
            <button key={h.id} onClick={() => openHistory(h)} className={`overflow-hidden rounded-xl border text-left transition hover:border-cyan-400/50 ${ex?.id === h.id ? "border-cyan-400" : "border-white/10"}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {h.thumb ? <img src={h.thumb} alt="" className="aspect-video w-full object-cover" /> : <div className="aspect-video bg-slate-800" />}
              <div className="p-2">
                <div className="truncate text-xs font-semibold">{h.title}</div>
                <div className="mt-1 flex items-center justify-between">
                  <Badge color={h.status === "VERIFIED" ? "emerald" : h.status === "FAILED" ? "orange" : "amber"}>{h.status === "VERIFIED" ? "Đã xác minh" : h.status === "FAILED" ? "Sai" : "Tạm"}</Badge>
                  <span className="text-[10px] text-slate-500">{new Date(h.createdAt).toLocaleDateString("vi-VN")}</span>
                </div>
              </div>
            </button>
          ))}
          {!history.length && <p className="col-span-full text-sm text-slate-400">Chưa có trích xuất nào.</p>}
        </div>
      </section>

      <Modal open={captureOpen} onClose={() => setCaptureOpen(false)} title="Chụp ảnh">
        <video ref={videoRef} playsInline muted className="w-full rounded-xl bg-black" />
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={() => setCaptureOpen(false)} className="btn btn-ghost">Hủy</button>
          <button onClick={takePhoto} className="btn btn-primary"><Camera className="h-4 w-4" /> Chụp</button>
        </div>
      </Modal>
    </div>
  );
}
