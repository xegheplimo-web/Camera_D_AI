/* Lightweight browser helpers. No TensorFlow, OCR runtimes or model weights are downloaded. */
export function getDeviceId(): string {
  if (typeof window === "undefined") return "server";
  let id = localStorage.getItem("dai_device_id");
  if (!id) {
    const kind = /Android/i.test(navigator.userAgent) ? "android" : /iPhone|iPad/i.test(navigator.userAgent) ? "ios" : /Windows/i.test(navigator.userAgent) ? "windows" : "web";
    id = `${kind}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem("dai_device_id", id);
  }
  return id;
}
export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, { ...rest, headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) }, body: json !== undefined ? JSON.stringify(json) : rest.body, cache: "no-store" });
  if (!res.ok) {
    let message = `Lỗi ${res.status}`;
    try { const p = await res.json(); message = [p.title, p.detail].filter(Boolean).join(": ") || message; } catch { /* no raw response leak */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}
export type Roi = { x: number; y: number; w: number; h: number };
export function drawToCanvas(src: CanvasImageSource, sw: number, sh: number, maxDim = 1600, roi?: Roi | null): HTMLCanvasElement {
  const sx = roi ? roi.x * sw : 0, sy = roi ? roi.y * sh : 0;
  const cw = roi ? roi.w * sw : sw, ch = roi ? roi.h * sh : sh;
  const scale = Math.min(1, maxDim / Math.max(cw, ch));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(cw * scale)); c.height = Math.max(1, Math.round(ch * scale));
  c.getContext("2d")!.drawImage(src, sx, sy, cw, ch, 0, 0, c.width, c.height);
  return c;
}
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => resolve(img); img.onerror = () => reject(new Error("Không đọc được ảnh")); img.src = src; });
}
export async function fileToDataUrl(file: File, maxDim = 1600) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Chỉ hỗ trợ JPEG, PNG hoặc WebP");
  if (file.size > 25 * 1024 * 1024) throw new Error("Ảnh vượt giới hạn 25 MB");
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    if (img.naturalWidth * img.naturalHeight > 40_000_000) throw new Error("Ảnh vượt giới hạn 40 megapixel");
    const c = drawToCanvas(img, img.naturalWidth, img.naturalHeight, maxDim);
    return { dataUrl: c.toDataURL("image/jpeg", 0.9), width: c.width, height: c.height };
  } finally { URL.revokeObjectURL(url); }
}
export function uploadDataUrl(dataUrl: string, extra: { width?: number; height?: number; origin?: string; cameraId?: number | null } = {}) {
  return api<{ id: number; url: string; duplicate?: boolean }>("/api/assets", { method: "POST", json: { dataUrl, ...extra } });
}
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(blob); });
}

/** Same view contract as the old detector, now only a Gateway client. Nothing executes AI on this device. */
export async function getDetector() {
  return {
    async detect(el: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement, maxBoxes = 20, minScore = 0.45) {
      const w = el instanceof HTMLVideoElement ? el.videoWidth : el instanceof HTMLImageElement ? el.naturalWidth : el.width;
      const h = el instanceof HTMLVideoElement ? el.videoHeight : el instanceof HTMLImageElement ? el.naturalHeight : el.height;
      const frame = drawToCanvas(el, w, h, 640);
      const result = await api<{ detections: { class: string; score: number; bbox: number[] }[] }>("/api/vision/frame", { method: "POST", json: { image: frame.toDataURL("image/jpeg", 0.75) } });
      return result.detections.filter((d) => d.score >= minScore).slice(0, maxBoxes).map((d) => ({ class: d.class, score: d.score, bbox: [d.bbox[0] * w, d.bbox[1] * h, d.bbox[2] * w, d.bbox[3] * h] as [number, number, number, number] }));
    },
  };
}
