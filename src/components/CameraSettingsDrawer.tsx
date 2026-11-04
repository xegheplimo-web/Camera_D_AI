"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ArrowLeft, Film, ImagePlus, Loader2, Plus, Save, Sparkles, Trash2, Upload, X } from "lucide-react";
import { api, blobToDataUrl, fileToDataUrl, uploadDataUrl } from "@/lib/client";
import { CAMERA_FEATURES, normalizeFeatures, type CameraFeatureId } from "@/lib/camera/features";
import { Badge } from "./ui";
import type { Cam } from "./CameraView";

type CamSettings = {
  cameraId: number;
  profile: string;
  features: Record<string, unknown>;
  recordEnabled: boolean;
  recordAudio: boolean;
  retentionDays: number;
  detectFps: number;
  zones: Record<string, unknown>[];
  countLines: Record<string, unknown>[];
  privacyMasks: Record<string, unknown>[];
  notifyEnabled: boolean;
  revision: number;
  /** Server tính — xem GET /settings: cờ nào === true mới được bật; `reason` giải thích cờ khoá. `audio` = luồng có track âm thanh. */
  capabilities?: Partial<Record<FlagKey | "audio", boolean>> & { reason?: Record<string, string> };
  /** P1: cờ tính năng đã chuẩn hoá phía server (normalizeFeatures) — client không tự suy mặc định. */
  featureFlags?: Record<CameraFeatureId, boolean>;
};

type KItem = { id: number; title: string; sku: string | null; note: string | null; priceVnd: number | null; createdAt: string };
type KImage = { id: number; assetId: number; note: string | null; position: number; shareToLibrary?: boolean };
type TeachState = { images: number; embedded: number; ready: boolean };
type KDetail = KItem & { images: KImage[]; priceHistory: { id: number; priceVnd: number; effectiveFrom: string }[] };
type EvThumb = { id: number; assetId: number | null; thumb: string | null; label: string; happenedAt: string };

const PROFILES: [string, string][] = [
  ["family", "Gia đình"],
  ["shop", "Cửa hàng"],
  ["warehouse", "Kho"],
  ["parking", "Bãi xe"],
  ["factory", "Nhà xưởng"],
  ["custom", "Tùy chỉnh"],
];

type FlagKey = "live" | "playback" | "snapshot" | "record" | "ask" | "pricing";

const UPLOAD_MAX = 25 * 1024 * 1024;
const UPLOAD_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "video/webm", "video/mp4"]);
const ACCEPT_UPLOAD = [...UPLOAD_MIMES].join(",");
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const zoneLabel = (z: Record<string, unknown>, i: number, fallback: string) => {
  const n = z.name ?? z.label ?? z.title;
  return typeof n === "string" && n.trim() ? n : `${fallback} ${i + 1}`;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <h3 className="mb-2.5 text-sm font-semibold text-cyan-200">{title}</h3>
      {children}
    </section>
  );
}

function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange?: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-cyan-500" : "bg-slate-600"} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

export default function CameraSettingsDrawer({ cam, onClose, onSaved }: { cam: Cam; onClose: () => void; onSaved?: () => void }) {
  const [s, setS] = useState<CamSettings | null>(null);
  const [items, setItems] = useState<KItem[] | null>(null);
  const [picker, setPicker] = useState<EvThumb[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [nameD, setNameD] = useState<string | null>(null);
  const [locD, setLocD] = useState<string | null>(null);
  const [noteD, setNoteD] = useState<string | null>(null);
  const [retD, setRetD] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newNote, setNewNote] = useState("");
  const [detail, setDetail] = useState<KDetail | null>(null);
  const [teach, setTeach] = useState<TeachState | null>(null);
  const [gtin, setGtin] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [itemTitleD, setItemTitleD] = useState<string | null>(null);
  const [itemNoteD, setItemNoteD] = useState<string | null>(null);
  const [imgDrafts, setImgDrafts] = useState<Record<number, string>>({});
  const [confirmDel, setConfirmDel] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upPreview, setUpPreview] = useState<string | null>(null);
  const [upNote, setUpNote] = useState("");
  const [upPrice, setUpPrice] = useState("");
  const [upErr, setUpErr] = useState<string | null>(null);
  const [upBusy, setUpBusy] = useState(false);
  const [pendingVids, setPendingVids] = useState<{ itemId: number; assetId: number; name: string; size: number; note: string | null }[]>([]);
  const upInputRef = useRef<HTMLInputElement>(null);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2600);
  };

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const [st, it, ev] = await Promise.all([
        api<CamSettings>(`/api/cameras/${cam.id}/settings`),
        api<KItem[]>(`/api/knowledge/items?cameraId=${cam.id}`),
        api<{ items: EvThumb[] }>(`/api/events?camera=${cam.id}&limit=30`),
      ]);
      setS(st);
      setItems(it);
      const seen = new Set<number>();
      setPicker(ev.items.filter((e) => e.assetId && e.thumb && !seen.has(e.assetId) && (seen.add(e.assetId), true)));
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Không tải được cài đặt");
    }
  }, [cam.id]);

  useEffect(() => {
    setS(null);
    setItems(null);
    setDetail(null);
    setNameD(null);
    setLocD(null);
    setNoteD(null);
    setRetD(null);
    setItemTitleD(null);
    setItemNoteD(null);
    setImgDrafts({});
    setConfirmDel(false);
    setShowPicker(false);
    setUpFile(null);
    setUpPreview(null);
    setUpNote("");
    setUpPrice("");
    setUpErr(null);
    setPendingVids([]);
    void load();
  }, [cam.id, load]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Object-URL của ảnh xem trước: thu hồi khi đổi/huỷ tệp và khi drawer unmount.
  useEffect(() => () => { if (upPreview) URL.revokeObjectURL(upPreview); }, [upPreview]);

  /** PATCH kèm revision; 409 → nạp bản mới từ server, không ghi đè. Caller giữ cờ `saving`. */
  const patchSettings = async (fields: Record<string, unknown>): Promise<boolean> => {
    if (!s) return false;
    try {
      const res = await fetch(`/api/cameras/${cam.id}/settings`, {
        method: "PATCH",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: s.revision, ...fields }),
      });
      if (res.status === 409) {
        const p = (await res.json().catch(() => null)) as { settings?: CamSettings } | null;
        if (p?.settings) setS(p.settings);
        else await load();
        flash("Cài đặt đã thay đổi ở nơi khác");
        return false;
      }
      if (!res.ok) {
        const p = (await res.json().catch(() => null)) as { title?: string; detail?: string } | null;
        throw new Error([p?.title, p?.detail].filter(Boolean).join(": ") || `Lỗi ${res.status}`);
      }
      setS((await res.json()) as CamSettings);
      return true;
    } catch (e) {
      flash(e instanceof Error ? e.message : "Lỗi lưu cài đặt");
      return false;
    }
  };

  const save = async (fields: Record<string, unknown>) => {
    if (!s || saving) return false;
    setSaving(true);
    const ok = await patchSettings(fields);
    setSaving(false);
    return ok;
  };

  // "Ghi hình" lái cột record_enabled (control-plane thật qua recorder); các cờ còn lại vẫn là tuỳ chọn trong features.
  const setFlag = (key: CameraFeatureId, v: boolean) =>
    void save(key === "record" ? { recordEnabled: v } : { features: { ...s!.features, [key]: v } });

  const name = nameD ?? cam.name;
  const loc = locD ?? cam.location;
  const noteSaved = typeof s?.features.note === "string" ? s.features.note : "";
  const note = noteD ?? noteSaved;
  const infoDirty = name.trim() !== cam.name || loc.trim() !== cam.location || note !== noteSaved;
  const saveInfo = async () => {
    if (!s || saving) return;
    setSaving(true);
    try {
      if (name.trim() !== cam.name || loc.trim() !== cam.location) {
        await api(`/api/cameras/${cam.id}`, { method: "PATCH", json: { name: name.trim(), location: loc.trim() } });
        onSaved?.();
        setNameD(null);
        setLocD(null);
      }
      if (note !== noteSaved) {
        const f = { ...s.features };
        if (note.trim()) f.note = note.trim();
        else delete f.note;
        if (await patchSettings({ features: f })) setNoteD(null);
      }
    } catch (e) {
      flash(e instanceof Error ? e.message : "Lỗi lưu thông tin");
    } finally {
      setSaving(false);
    }
  };

  const retention = retD ?? (s ? String(s.retentionDays) : "");
  const ret = Number(retention);
  const retentionDirty = s ? ret !== s.retentionDays : false;

  // Draft chỉ reset khi đổi sang MỤC khác — reload cùng mục (sau gắn/lưu ảnh) không được xoá chữ đang gõ.
  const resetItemDrafts = () => {
    setItemTitleD(null);
    setItemNoteD(null);
    setImgDrafts({});
    setConfirmDel(false);
    setShowPicker(false);
    resetUpload();
  };

  const openItem = async (id: number) => {
    setDetailBusy(true);
    try {
      const d = await api<KDetail>(`/api/knowledge/items/${id}`);
      if (detail?.id !== d.id) resetItemDrafts();
      setDetail(d);
      setGtin(String((d as unknown as { custom?: { gtin?: string } }).custom?.gtin ?? ""));
      api<TeachState>(`/api/products/${id}/embed`).then(setTeach).catch(() => setTeach(null));
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không mở được mục");
    } finally {
      setDetailBusy(false);
    }
  };

  const addItem = async () => {
    if (!newTitle.trim() || saving) return;
    setSaving(true);
    try {
      await api("/api/knowledge/items", { method: "POST", json: { scope: "camera", cameraId: cam.id, title: newTitle.trim(), note: newNote.trim() || null } });
      setNewTitle("");
      setNewNote("");
      setItems(await api<KItem[]>(`/api/knowledge/items?cameraId=${cam.id}`));
      flash("Đã thêm mục");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không thêm được mục");
    } finally {
      setSaving(false);
    }
  };

  const itemTitle = itemTitleD ?? detail?.title ?? "";
  const itemNote = itemNoteD ?? detail?.note ?? "";
  const itemDirty = detail ? itemTitle !== detail.title || itemNote !== (detail.note ?? "") : false;
  const clearImgDraft = (id: number) => setImgDrafts((m) => { const n = { ...m }; delete n[id]; return n; });

  const saveItem = async () => {
    if (!detail || !itemTitle.trim() || saving) return;
    setSaving(true);
    try {
      await api(`/api/knowledge/items/${detail.id}`, { method: "PATCH", json: { title: itemTitle.trim(), note: itemNote.trim() || null } });
      await openItem(detail.id);
      setItemTitleD(null);
      setItemNoteD(null);
      setItems(await api<KItem[]>(`/api/knowledge/items?cameraId=${cam.id}`));
      flash("Đã lưu mục");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không lưu được mục");
    } finally {
      setSaving(false);
    }
  };

  const removeItem = async () => {
    if (!detail || !confirmDel) return setConfirmDel(true);
    setSaving(true);
    try {
      await api(`/api/knowledge/items/${detail.id}`, { method: "DELETE" });
      setDetail(null);
      setItems(await api<KItem[]>(`/api/knowledge/items?cameraId=${cam.id}`));
      flash("Đã xoá mục");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không xoá được mục");
    } finally {
      setSaving(false);
      setConfirmDel(false);
    }
  };

  const attach = async (assetId: number) => {
    if (!detail || saving) return;
    setSaving(true);
    try {
      await api(`/api/knowledge/items/${detail.id}/images`, { method: "POST", json: { assetId } });
      // T-1362: gắn ảnh xong là cho AI học ngay (idempotent, không cần chờ train).
      const r = await api<{ encoded: number }>(`/api/products/${detail.id}/embed`, { method: "POST" }).catch(() => null);
      await openItem(detail.id);
      flash(r && r.encoded > 0 ? "Đã gắn ảnh và cho AI học" : "Đã gắn ảnh");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không gắn được ảnh");
    } finally {
      setSaving(false);
    }
  };

  const teachNow = async () => {
    if (!detail || saving) return;
    setSaving(true);
    try {
      const r = await api<{ encoded: number; avgMs?: number }>(`/api/products/${detail.id}/embed`, { method: "POST" });
      setTeach(await api<TeachState>(`/api/products/${detail.id}/embed`));
      flash(r.encoded > 0 ? `AI đã học ${r.encoded} ảnh` : "Chưa có ảnh nào đọc được để học");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không học được ảnh");
    } finally {
      setSaving(false);
    }
  };

  const saveGtin = async () => {
    if (!detail || saving) return;
    setSaving(true);
    try {
      await api(`/api/knowledge/items/${detail.id}`, { method: "PATCH", json: { gtin: gtin.trim() || null } });
      await openItem(detail.id);
      flash("Đã lưu mã vạch");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Mã vạch không hợp lệ");
    } finally {
      setSaving(false);
    }
  };

  const toggleShare = async (im: KImage, on: boolean) => {
    if (!detail || saving) return;
    setSaving(true);
    try {
      await api(`/api/knowledge/images/${im.id}`, { method: "PATCH", json: { shareToLibrary: on } });
      await openItem(detail.id);
      flash(on ? "Đã đồng ý chia sẻ ảnh này" : "Đã tắt chia sẻ ảnh này");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không đổi được lựa chọn chia sẻ");
    } finally {
      setSaving(false);
    }
  };

  const saveImageNote = async (im: KImage) => {
    if (!detail || saving) return;
    setSaving(true);
    try {
      await api(`/api/knowledge/images/${im.id}`, { method: "PATCH", json: { note: (imgDrafts[im.id] ?? "").trim() || null } });
      await openItem(detail.id);
      clearImgDraft(im.id);
      flash("Đã lưu ghi chú ảnh");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không lưu được ghi chú");
    } finally {
      setSaving(false);
    }
  };

  const detachImage = async (im: KImage) => {
    if (!detail || saving) return;
    setSaving(true);
    try {
      await api(`/api/knowledge/images/${im.id}`, { method: "DELETE" });
      await openItem(detail.id);
      clearImgDraft(im.id);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Không gỡ được ảnh");
    } finally {
      setSaving(false);
    }
  };

  const resetUpload = () => {
    if (upPreview) URL.revokeObjectURL(upPreview);
    setUpPreview(null);
    setUpFile(null);
    setUpNote("");
    setUpPrice("");
    setUpErr(null);
    if (upInputRef.current) upInputRef.current.value = "";
  };

  const pickFile = (f: File | null) => {
    resetUpload();
    if (!f) return;
    if (!UPLOAD_MIMES.has(f.type)) {
      setUpErr("Định dạng không hỗ trợ — chỉ nhận JPEG, PNG, WEBP hoặc video WEBM/MP4.");
      return;
    }
    if (f.size > UPLOAD_MAX) {
      setUpErr(`Tệp quá lớn (${fmtSize(f.size)}) — tối đa 25 MB.`);
      return;
    }
    setUpFile(f);
    if (f.type.startsWith("image/")) setUpPreview(URL.createObjectURL(f));
  };

  /** Lỗi tải tệp → tiếng Việt rõ ràng: mất mạng, hết phiên, thiếu quyền; còn lại giữ thông điệp server. */
  const uploadErrText = (e: unknown): string => {
    const m = e instanceof Error ? e.message : "";
    if (e instanceof TypeError || /failed to fetch|net::ERR|load failed/i.test(m)) return "Mất kết nối mạng — kiểm tra mạng rồi thử lại.";
    if (/\b401\b|hết hiệu lực/i.test(m)) return "Phiên đăng nhập đã hết hạn — hãy đăng nhập lại.";
    if (/\b403\b|không đủ quyền/i.test(m)) return "Tài khoản không có quyền tải tệp lên.";
    return m || "Không lưu được tệp";
  };

  const saveUpload = async () => {
    if (!detail || !upFile || upBusy || saving) return;
    const isVideo = upFile.type.startsWith("video/");
    const note = upNote.trim() || null;
    let price: number | null = null;
    if (!isVideo && upPrice.trim()) {
      const n = Number(upPrice.trim());
      if (!Number.isSafeInteger(n) || n < 0) {
        setUpErr("Giá không hợp lệ — nhập số nguyên ≥ 0 (VND).");
        return;
      }
      price = n;
    }
    setUpBusy(true);
    setUpErr(null);
    try {
      const extra: { origin: string; cameraId: number; width?: number; height?: number } = { origin: "upload", cameraId: cam.id };
      let dataUrl: string;
      if (isVideo) dataUrl = await blobToDataUrl(upFile);
      else {
        const c = await fileToDataUrl(upFile);
        dataUrl = c.dataUrl;
        extra.width = c.width;
        extra.height = c.height;
      }
      const a = await uploadDataUrl(dataUrl, extra);
      if (isVideo) {
        // Phía máy chủ hiện chỉ nhận gắn ảnh vào mục — video nằm sẵn trong kho
        // của camera, hiển thị "Chờ xử lý" tới khi hệ thống gắn/lập chỉ mục được.
        const attached = await api(`/api/knowledge/items/${detail.id}/images`, { method: "POST", json: { assetId: a.id, note } })
          .then(() => true)
          .catch(() => false);
        if (attached) {
          await openItem(detail.id);
          flash("Đã lưu video");
        } else {
          setPendingVids((v) => [{ itemId: detail.id, assetId: a.id, name: upFile.name, size: upFile.size, note }, ...v]);
          flash("Đã lưu video · Chờ xử lý");
        }
      } else {
        await api(`/api/knowledge/items/${detail.id}/images`, { method: "POST", json: { assetId: a.id, note } });
        if (price !== null && price !== detail.priceVnd)
          await api(`/api/knowledge/items/${detail.id}/price`, { method: "POST", json: { priceVnd: price } });
        // Như attach-from-event: gắn ảnh xong cho AI học ngay (idempotent).
        const r = await api<{ encoded: number }>(`/api/products/${detail.id}/embed`, { method: "POST" }).catch(() => null);
        await openItem(detail.id);
        flash(r && r.encoded > 0 ? "Đã lưu và cho AI học" : "Đã lưu");
      }
      resetUpload();
    } catch (e) {
      setUpErr(uploadErrText(e));
    } finally {
      setUpBusy(false);
    }
  };

  // P1: cờ tính năng lấy từ settingsView (server đã normalize); `record` lái cột
  // record_enabled nên trạng thái "bật" lấy từ cột thật, không phải khoá features.
  const feat: Record<CameraFeatureId, boolean> = {
    ...(s?.featureFlags ?? normalizeFeatures(s?.features)),
    record: s?.recordEnabled === true,
  };
  const recReady = s?.capabilities?.record === true;
  const recReason = s?.capabilities?.reason?.record;
  const hasAudio = recReady && s?.capabilities?.audio === true;
  const attachedAssets = new Set((detail?.images ?? []).map((im) => im.assetId));
  const fmtVnd = (v: number | null) => (v === null ? null : `${v.toLocaleString("vi-VN")} ₫`);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
      {/* Lớp phủ là <button> thật: đóng được bằng chuột, Enter và Space (Sonar S1082). */}
      <button
        type="button"
        aria-label="Đóng cài đặt"
        className="absolute inset-0 h-full w-full cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Cài đặt camera"
        className="scroll-thin relative h-full w-full max-w-md space-y-3 overflow-y-auto border-l border-cyan-400/20 bg-[#0b1626] p-4"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold">Cài đặt — {cam.name}</h2>
            <p className="truncate text-xs text-slate-400">{cam.location}</p>
          </div>
          <button onClick={onClose} aria-label="Đóng cài đặt" title="Đóng" className="rounded-lg p-2 text-slate-300 hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        {loadErr && (
          <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
            {loadErr} <button onClick={() => void load()} className="ml-2 font-semibold underline">Thử lại</button>
          </div>
        )}
        {!s && !loadErr && <p className="text-sm text-slate-400">Đang tải cài đặt…</p>}

        {/* 1. Thông tin & vị trí */}
        <Section title="Thông tin & vị trí">
          <div className="space-y-2">
            <label className="block text-xs text-slate-400">
              Tên hiển thị
              <input value={name} onChange={(e) => setNameD(e.target.value)} maxLength={60} className="input mt-1" />
            </label>
            <label className="block text-xs text-slate-400">
              Vị trí / khu vực
              <input value={loc} onChange={(e) => setLocD(e.target.value)} maxLength={80} className="input mt-1" />
            </label>
            <label className="block text-xs text-slate-400">
              Ghi chú ngắn
              <textarea value={note} onChange={(e) => setNoteD(e.target.value)} rows={2} maxLength={500} className="input mt-1" placeholder="Ví dụ: quay quầy thu ngân, ưu tiên giờ cao điểm" />
            </label>
            <div className="flex justify-end">
              <button onClick={saveInfo} disabled={!s || saving || !infoDirty || !name.trim() || !loc.trim()} className="btn btn-primary py-1.5 text-xs">
                <Save className="h-3.5 w-3.5" /> Lưu thông tin
              </button>
            </div>
          </div>
        </Section>

        {/* 2. Tính năng AI */}
        <Section title="Tính năng AI">
          <label className="block text-xs text-slate-400">
            Hồ sơ
            <select
              aria-label="Hồ sơ"
              value={s?.profile ?? "custom"}
              disabled={!s || saving}
              onChange={(e) => void save({ profile: e.target.value })}
              className="input mt-1"
            >
              {PROFILES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </Section>

        {/* 3. Tính năng camera — luôn hiển thị: đây là nơi bật tính năng cho riêng camera này.
               Tắt chỉ giấu mục liên quan, không xoá dữ liệu đã lưu. */}
        <Section title="Tính năng camera">
          <div className="divide-y divide-white/5">
            {CAMERA_FEATURES.map((f) => {
              const isRecord = f.id === "record";
              const blocked = isRecord && !recReady;
              return (
                <div key={f.id} data-feature={f.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0">
                    {f.label}
                    <span className="block truncate text-[11px] font-normal text-slate-500">
                      {blocked && recReason ? recReason : f.hint}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {blocked && s && <Badge color="slate">Chưa khả dụng</Badge>}
                    <Switch
                      label={f.label}
                      checked={isRecord ? s?.recordEnabled === true : feat[f.id]}
                      disabled={!s || saving || blocked}
                      onChange={(v) => setFlag(f.id, v)}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        </Section>

        {/* 4. Ảnh & ghi chú — chỉ khi camera bật nhận diện hàng hoá hoặc đếm kho */}
        {feat.product || feat.stock ? (
        <Section title="Ảnh & ghi chú">
          {!detail ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} maxLength={200} placeholder="Tiêu đề mục" aria-label="Tiêu đề mục" className="input" />
              </div>
              <div className="flex gap-2">
                <input value={newNote} onChange={(e) => setNewNote(e.target.value)} maxLength={500} placeholder="Ghi chú (tuỳ chọn)" aria-label="Ghi chú mục mới" className="input" />
                <button onClick={addItem} disabled={saving || !newTitle.trim()} className="btn btn-primary shrink-0 py-1.5 text-xs">
                  <Plus className="h-3.5 w-3.5" /> Thêm mục
                </button>
              </div>
              <div className="space-y-1.5">
                {items?.map((it) => (
                  <div key={it.id} data-item={it.id} className="flex items-center gap-2 rounded-lg border border-white/10 px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{it.title}</div>
                      <div className="truncate text-[11px] text-slate-400">
                        {[it.sku, fmtVnd(it.priceVnd), it.note].filter(Boolean).join(" · ") || "Không có ghi chú"}
                      </div>
                    </div>
                    <button onClick={() => { setShowPicker(false); void openItem(it.id); }} disabled={detailBusy} className="btn btn-ghost shrink-0 px-2.5 py-1 text-xs">Mở</button>
                  </div>
                ))}
                {items && !items.length && <p className="py-2 text-center text-xs text-slate-400">Chưa có mục nào cho camera này.</p>}
                {items === null && !loadErr && <p className="py-2 text-center text-xs text-slate-400"><Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Đang tải…</p>}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <button onClick={() => { setDetail(null); resetItemDrafts(); }} className="flex items-center gap-1 text-xs text-cyan-300 hover:underline">
                <ArrowLeft className="h-3.5 w-3.5" /> Quay lại danh sách
              </button>
              <label className="block text-xs text-slate-400">
                Tiêu đề
                <input value={itemTitle} onChange={(e) => setItemTitleD(e.target.value)} maxLength={200} className="input mt-1" />
              </label>
              <label className="block text-xs text-slate-400">
                Ghi chú mục
                <textarea value={itemNote} onChange={(e) => setItemNoteD(e.target.value)} rows={2} maxLength={2000} className="input mt-1" />
              </label>
              {detail.priceVnd !== null && (
                <p className="text-xs text-slate-300">Giá: <b>{fmtVnd(detail.priceVnd)}</b>{detail.priceHistory.length > 1 && <span className="text-slate-400"> · {detail.priceHistory.length} lần đổi giá</span>}</p>
              )}
              <label className="block text-xs text-slate-400">
                Mã vạch (nếu có)
                <div className="mt-1 flex gap-1.5">
                  <input value={gtin} onChange={(e) => setGtin(e.target.value)} inputMode="numeric" maxLength={20} placeholder="8938505974194" aria-label="Mã vạch" data-gtin className="input" />
                  <button onClick={() => void saveGtin()} disabled={saving} aria-label="Lưu mã vạch" className="btn btn-ghost shrink-0 px-2 py-1 text-[11px]">Lưu</button>
                </div>
              </label>

              <div className="rounded-lg border border-cyan-400/20 p-2" data-teach-panel>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-200">Dạy AI nhận diện</span>
                  <span data-teach-status className={`text-[11px] font-semibold ${teach?.ready ? "text-emerald-300" : "text-amber-300"}`}>
                    {teach === null ? "Đang kiểm tra…" : teach.ready ? `Sẵn sàng · ${teach.embedded}/${teach.images} ảnh` : teach.images ? `Chưa học · ${teach.images} ảnh` : "Chưa có ảnh"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-400">Ảnh ở nhiều góc giúp nhận đúng hơn. Ảnh chỉ dùng cho cửa hàng này, không dùng để huấn luyện chung.</p>
                <button onClick={() => void teachNow()} disabled={saving || !teach?.images} data-teach className="btn btn-primary mt-1.5 px-2 py-1 text-[11px]">
                  <Sparkles className="h-3.5 w-3.5" /> Dạy AI nhận diện
                </button>
              </div>

              <div className="flex gap-2">
                <button onClick={saveItem} disabled={saving || !itemTitle.trim() || !itemDirty} className="btn btn-primary py-1 text-xs"><Save className="h-3.5 w-3.5" /> Lưu mục</button>
                <button onClick={removeItem} disabled={saving} className={`btn py-1 text-xs ${confirmDel ? "btn-danger" : "btn-ghost"}`}>
                  <Trash2 className="h-3.5 w-3.5" /> {confirmDel ? "Bấm lại để xoá" : "Xoá mục"}
                </button>
              </div>

              <div className="pt-1">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-300">Ảnh đính kèm ({detail.images.length})</span>
                  <button onClick={() => setShowPicker((v) => !v)} disabled={saving} className="btn btn-ghost px-2 py-1 text-[11px]">
                    <ImagePlus className="h-3.5 w-3.5" /> Thêm ảnh từ sự kiện
                  </button>
                </div>
                <div className="mb-2 rounded-lg border border-cyan-400/20 p-2" data-upload>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate-300">Tải ảnh/video lên</span>
                    <label className="btn btn-ghost cursor-pointer px-2 py-1 text-[11px]">
                      <Upload className="h-3.5 w-3.5" /> Chọn tệp…
                      <input
                        ref={upInputRef}
                        type="file"
                        accept={ACCEPT_UPLOAD}
                        aria-label="Chọn tệp ảnh hoặc video"
                        data-upload-input
                        disabled={upBusy}
                        className="sr-only"
                        onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                      />
                    </label>
                  </div>
                  {upFile ? (
                    <div className="mt-2 space-y-1.5">
                      <div className="flex items-center gap-2">
                        {upFile.type.startsWith("video/") ? (
                          <span className="flex h-16 w-24 shrink-0 items-center justify-center rounded-md bg-white/5" title={upFile.name}>
                            <Film className="h-6 w-6 text-slate-400" />
                          </span>
                        ) : upPreview?.startsWith("blob:") ? (
                          // next/image: blob: URL được Next tự đánh dấu unoptimized (get-img-props),
                          // render đúng <img src="blob:...">; dùng component thay vì thẻ thô để
                          // không tạo sink DOM-attribute cho CodeQL (js/xss-through-dom).
                          <Image src={upPreview} alt="Ảnh xem trước" width={96} height={64} className="h-16 w-24 shrink-0 rounded-md object-cover" />
                        ) : (
                          <span className="flex h-16 w-24 shrink-0 items-center justify-center rounded-md bg-white/5 text-[10px] text-slate-500">
                            Không xem trước được
                          </span>
                        )}
                        <div className="min-w-0 text-[11px] text-slate-400">
                          <div className="truncate font-medium text-slate-200">{upFile.name}</div>
                          <div>{fmtSize(upFile.size)}{upFile.type.startsWith("video/") ? " · chờ xử lý — AI chưa học video" : ""}</div>
                        </div>
                      </div>
                      <textarea
                        value={upNote}
                        onChange={(e) => setUpNote(e.target.value)}
                        rows={2}
                        maxLength={500}
                        placeholder="Ghi chú riêng cho tệp này…"
                        aria-label="Ghi chú tệp tải lên"
                        data-upload-note
                        className="input py-1 text-xs"
                      />
                      {!upFile.type.startsWith("video/") && (
                        <input
                          value={upPrice}
                          onChange={(e) => setUpPrice(e.target.value.replace(/\D/g, ""))}
                          inputMode="numeric"
                          maxLength={15}
                          placeholder="Giá VND (tuỳ chọn)"
                          aria-label="Giá VND cho mục"
                          data-upload-price
                          className="input py-1 text-xs"
                        />
                      )}
                      <div className="flex items-center gap-2">
                        <button onClick={() => void saveUpload()} disabled={upBusy || saving} data-upload-save className="btn btn-primary px-2 py-1 text-[11px]">
                          {upBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Lưu vào trí nhớ AI
                        </button>
                        <button onClick={resetUpload} disabled={upBusy} className="btn btn-ghost px-2 py-1 text-[11px]">Huỷ</button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1.5 text-[11px] text-slate-400">JPEG, PNG, WEBP hoặc video WEBM/MP4 · tối đa 25 MB.</p>
                  )}
                  {upErr && <p data-upload-error className="mt-1.5 rounded-md border border-rose-400/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-100">{upErr}</p>}
                  {pendingVids.filter((v) => v.itemId === detail.id).map((v) => (
                    <div key={v.assetId} data-pending-video={v.assetId} className="mt-1.5 flex items-center gap-2 rounded-md border border-white/10 px-2 py-1.5">
                      <Film className="h-4 w-4 shrink-0 text-slate-400" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11px] font-medium text-slate-200">{v.name} · {fmtSize(v.size)}</div>
                        {v.note && <div className="truncate text-[11px] text-slate-400">{v.note}</div>}
                      </div>
                      <Badge color="amber">Chờ xử lý</Badge>
                    </div>
                  ))}
                </div>
                {showPicker && (
                  <div className="mb-2 rounded-lg border border-cyan-400/20 p-2">
                    <p className="mb-1.5 text-[11px] text-slate-400">Chọn ảnh từ sự kiện gần đây của camera:</p>
                    <div className="grid max-h-44 grid-cols-3 gap-1.5 overflow-y-auto">
                      {(picker ?? []).filter((e) => !attachedAssets.has(e.assetId!)).map((e) => (
                        <button key={e.id} data-asset={e.assetId} onClick={() => void attach(e.assetId!)} disabled={saving} title={e.label} className="group relative aspect-video overflow-hidden rounded-lg border border-white/10 hover:border-cyan-400/60">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={e.thumb!} alt={e.label} className="h-full w-full object-cover" />
                        </button>
                      ))}
                    </div>
                    {picker && !picker.some((e) => !attachedAssets.has(e.assetId!)) && <p className="text-[11px] text-slate-400">Không còn ảnh sự kiện nào để gắn.</p>}
                    {picker === null && <p className="text-[11px] text-slate-400">Đang tải ảnh…</p>}
                  </div>
                )}
                <div className="space-y-2">
                  {detail.images.map((im) => {
                    const cur = imgDrafts[im.id] ?? im.note ?? "";
                    const changed = im.id in imgDrafts && cur !== (im.note ?? "");
                    return (
                      <div key={im.id} data-image={im.id} className="flex gap-2 rounded-lg border border-white/10 p-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/assets/${im.assetId}`} alt={`Ảnh ${im.id}`} className="h-16 w-24 shrink-0 rounded-md object-cover" />
                        <div className="min-w-0 flex-1 space-y-1">
                          <textarea
                            value={cur}
                            onChange={(e) => setImgDrafts((m) => ({ ...m, [im.id]: e.target.value }))}
                            rows={2}
                            maxLength={2000}
                            placeholder="Ghi chú cho ảnh này…"
                            aria-label="Ghi chú ảnh"
                            className="input py-1 text-xs"
                          />
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button onClick={() => void saveImageNote(im)} disabled={saving || !changed} aria-label="Lưu ghi chú ảnh" className="btn btn-primary px-2 py-0.5 text-[11px]">Lưu</button>
                            <button onClick={() => void detachImage(im)} disabled={saving} aria-label="Gỡ ảnh" className="btn btn-ghost px-2 py-0.5 text-[11px]">Gỡ ảnh</button>
                            <label className="ml-auto flex items-center gap-1 text-[11px] text-slate-400">
                              <input type="checkbox" data-share={im.id} checked={im.shareToLibrary === true} disabled={saving} onChange={(e) => void toggleShare(im, e.target.checked)} aria-label="Chia sẻ ảnh cho thư viện chung" className="h-3 w-3" />
                              Chia sẻ cho thư viện chung
                            </label>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {!detail.images.length && <p className="text-[11px] text-slate-400">Chưa có ảnh — gắn từ sự kiện của camera.</p>}
                </div>
              </div>
            </div>
          )}
        </Section>
        ) : null}

        {/* 5. Khu vực & quy tắc — chỉ khi camera bật chuyển động/xâm nhập/đếm người/đếm kho */}
        {feat.motion || feat.intrusion || feat.people || feat.stock ? (
        <Section title="Khu vực & quy tắc">
          {(
            [
              ["Khu vực quan tâm (ROI)", s?.zones ?? [], "Khu vực"],
              ["Vạch đếm", s?.countLines ?? [], "Vạch đếm"],
              ["Vùng che riêng tư", s?.privacyMasks ?? [], "Vùng che"],
            ] as [string, Record<string, unknown>[], string][]
          ).map(([label, arr, fallback]) => (
            <div key={label} className="mb-2">
              <p className="text-xs font-semibold text-slate-300">{label} ({arr.length})</p>
              {arr.length ? (
                <ul className="mt-1 space-y-0.5 text-xs text-slate-300">
                  {arr.map((z, i) => <li key={i} className="rounded-md bg-white/5 px-2 py-1">· {zoneLabel(z, i, fallback)}</li>)}
                </ul>
              ) : (
                <p className="mt-0.5 text-[11px] text-slate-500">Chưa thiết lập.</p>
              )}
            </div>
          ))}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button disabled className="btn btn-ghost py-1 text-xs">Vẽ khu vực</button>
            <button disabled className="btn btn-ghost py-1 text-xs">Vẽ vạch đếm</button>
            <Badge color="slate">Chưa khả dụng</Badge>
          </div>
        </Section>
        ) : null}

        {/* 6. Lưu trữ & cảnh báo — chỉ khi camera bật ghi hình */}
        {feat.record ? (
        <Section title="Lưu trữ & cảnh báo">
          <div className="space-y-2">
            <div className="flex items-end gap-2">
              <label className="block flex-1 text-xs text-slate-400">
                Số ngày lưu trữ (1–365)
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={retention}
                  onChange={(e) => setRetD(e.target.value)}
                  aria-label="Số ngày lưu trữ"
                  className="input mt-1"
                />
              </label>
              <button
                onClick={() => void save({ retentionDays: ret }).then((ok) => ok && setRetD(null))}
                disabled={!s || saving || !retentionDirty || !Number.isSafeInteger(ret) || ret < 1 || ret > 365}
                className="btn btn-primary py-1.5 text-xs"
              >
                Lưu
              </button>
            </div>
            <div className="flex items-center justify-between gap-2 py-1 text-sm" data-flag="notify">
              <span>Bật thông báo & cảnh báo</span>
              <Switch label="Bật thông báo & cảnh báo" checked={s?.notifyEnabled ?? false} disabled={!s || saving} onChange={(v) => void save({ notifyEnabled: v })} />
            </div>
            <div className="flex items-center justify-between gap-2 py-1 text-sm" data-flag="record">
              <span className="min-w-0">
                Ghi hình liên tục
                {!recReady && recReason ? <span className="block truncate text-[11px] font-normal text-slate-500">{recReason}</span> : null}
              </span>
              <span className="flex items-center gap-2">
                {!recReady && s && <Badge color="slate">Chưa khả dụng</Badge>}
                <Switch label="Ghi hình liên tục" checked={s?.recordEnabled ?? false} disabled={!recReady || saving} onChange={(v) => void save({ recordEnabled: v })} />
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 py-1 text-sm" data-flag="recordAudio">
              <span>Ghi âm kèm video</span>
              <span className="flex items-center gap-2">
                <span className="text-[11px] text-slate-400">{hasAudio ? "Tự động theo luồng camera" : "Camera không có âm thanh"}</span>
                <Badge color={hasAudio ? "emerald" : "slate"}>{hasAudio ? "Có âm thanh" : "Không có âm thanh"}</Badge>
              </span>
            </div>
            <p className="text-[11px] text-slate-500">Ghi hình chạy trên máy chủ (mediaMTX), không phụ thuộc trình duyệt. Tắt trình duyệt vẫn ghi tiếp.</p>
          </div>
        </Section>
        ) : null}

        {toast && <div className="anim-fadeup sticky bottom-2 rounded-xl bg-cyan-600/90 px-4 py-2 text-center text-sm font-medium shadow-lg">{toast}</div>}
      </div>
    </div>
  );
}
