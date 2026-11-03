"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PlusCircle, Activity, AlertTriangle, Wifi, Plus, RadioTower, Settings } from "lucide-react";
import CameraView, { type Cam } from "@/components/CameraView";
import CameraDiscovery, { type DiscoveryControls } from "@/components/CameraDiscovery";
import CameraSettingsDrawer from "@/components/CameraSettingsDrawer";
import EventDetail from "@/components/EventDetail";
import RecordingsPanel from "@/components/RecordingsPanel";
import { Card, EventRow, type EventItem, EventBadge } from "@/components/ui";
import { api, getDeviceId } from "@/lib/client";
import { listStatus, type ConnectionState } from "@/lib/camera/status";

type DashCam = Cam & { today: number; recent5m: number };
type CamHealth = { connection: ConnectionState; sourceKind: string; checkedAt: string };

export default function CameraPage() {
  const [cams, setCams] = useState<DashCam[]>([]);
  const [camId, setCamId] = useState<number | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [alerts, setAlerts] = useState<EventItem[]>([]);
  const [open, setOpen] = useState<EventItem | null>(null);
  const [manual, setManual] = useState({ label: "", note: "", priority: "normal" });
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState<string>("viewer");
  const [health, setHealth] = useState<Record<number, CamHealth>>({});
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [settingsId, setSettingsId] = useState<number | null>(null);
  const discovery = useRef<DiscoveryControls | null>(null);
  const registerDiscovery = useCallback((c: DiscoveryControls | null) => { discovery.current = c; }, []);

  const selectCam = useCallback((id: number | null) => {
    setCamId(id);
    // Trang /extract đọc camera đã chọn để "Chụp ảnh" lấy đúng khung hình.
    if (id) window.localStorage.setItem("dai_cam_id", String(id));
  }, []);

  const load = useCallback(async () => {
    const d = await api<{ cameras: DashCam[] }>("/api/dashboard");
    setCams(d.cameras);
    setCamId((c) => {
      const stored = Number(window.localStorage.getItem("dai_cam_id"));
      const pick = c ?? (d.cameras.some((x) => x.id === stored) ? stored : d.cameras[0]?.id) ?? null;
      if (pick) window.localStorage.setItem("dai_cam_id", String(pick));
      return pick;
    });
  }, []);

  useEffect(() => {
    api<{ role: string }>("/api/settings").then((r) => setRole(r.role)).catch(() => {});
  }, []);
  const canManage = role === "owner" || role === "operator";

  const loadEvents = useCallback(async (id: number) => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const [ev, al] = await Promise.all([
      api<{ items: EventItem[] }>(`/api/events?camera=${id}&from=${new Date(Date.now() - 24 * 3600000).toISOString()}&limit=60`),
      api<{ items: EventItem[] }>(`/api/events?type=alert&limit=5&from=${new Date(Date.now() - 7 * 86400000).toISOString()}`),
    ]);
    setEvents(ev.items);
    setAlerts(al.items);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Đồng hồ cho timeline: đặt sau mount để HTML prerender và lần hydrate đầu khớp nhau.
  useEffect(() => {
    setNowTs(Date.now());
    const t = setInterval(() => setNowTs(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Trạng thái kết nối thật từ probe server (mediaMTX) — nhãn không đọc cột status DB.
  useEffect(() => {
    const tick = async () => { try { setHealth(await api<Record<number, CamHealth>>("/api/cameras/health")); } catch {} };
    void tick();
    const t = setInterval(tick, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (camId) loadEvents(camId);
  }, [camId, loadEvents]);

  const cam = cams.find((c) => c.id === camId);

  const refresh = () => {
    load();
    if (camId) loadEvents(camId);
  };

  const onCameraAdded = (id?: number) => {
    void load();
    if (id) selectCam(id);
  };

  const createManual = async () => {
    if (!camId || !manual.label.trim()) return;
    setSaving(true);
    try {
      await api("/api/events", { method: "POST", json: { cameraId: camId, type: "manual", label: manual.label, note: manual.note, priority: manual.priority, tags: ["thủ công"], deviceId: getDeviceId() } });
      setManual({ label: "", note: "", priority: "normal" });
      refresh();
    } finally {
      setSaving(false);
    }
  };

  // Timeline 24 giờ. `nowTs` chỉ có sau khi mount: nếu tính bằng Date.now() ngay
  // trong render thì HTML prerender lúc build sẽ lệch giờ so với lúc hydrate
  // ⇒ React #418 (text content mismatch). Trước khi mount: 24 cột rỗng, không nhãn.
  const buckets = Array.from({ length: 24 }, (_, i) => {
    if (nowTs == null) return { h: null as number | null, items: [] as EventItem[] };
    const t = new Date(nowTs - (23 - i) * 3600000);
    const h = t.getHours();
    const items = events.filter((e) => {
      const d = new Date(e.happenedAt);
      return nowTs - d.getTime() < 24 * 3600000 && d.getHours() === h && Math.abs(d.getTime() - t.getTime()) < 3600000 * 1.01;
    });
    return { h, items };
  });
  const maxB = Math.max(1, ...buckets.map((b) => b.items.length));

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      <div className="space-y-3 xl:col-span-8">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Camera & Quan sát</h1>
          <select value={camId ?? ""} onChange={(e) => selectCam(Number(e.target.value))} className="input w-auto" aria-label="Chọn camera">
            {cams.map((c) => <option key={c.id} value={c.id}>{c.name} – {c.location}</option>)}
          </select>
        </div>
        {cam ? <CameraView cam={cam} onEvent={refresh} onSettings={canManage ? () => setSettingsId(cam.id) : undefined} /> : <div className="aspect-video animate-pulse rounded-xl bg-slate-800/50" />}
        {camId ? <RecordingsPanel cameraId={camId} /> : null}
        <CameraDiscovery cameras={cams} onAdded={onCameraAdded} canManage={canManage} onControlsReady={registerDiscovery} />

        <Card title="Dòng thời gian 24 giờ">
          <div className="flex h-20 items-end gap-1">
            {buckets.map((b, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1" title={b.h == null ? "" : `${b.h}h: ${b.items.length} sự kiện`}>
                <div className="w-full rounded-t bg-gradient-to-t from-cyan-700 to-cyan-300" style={{ height: `${(b.items.length / maxB) * 60 + (b.items.length ? 3 : 1)}px`, opacity: b.items.length ? 1 : 0.25 }} />
                <span className="text-[8px] text-slate-400">{b.h != null && i % 3 === 0 ? `${b.h}h` : ""}</span>
              </div>
            ))}
          </div>
          <div className="scroll-thin -mx-2 mt-3 grid max-h-80 gap-0.5 overflow-y-auto md:grid-cols-2">
            {events.map((e) => <EventRow key={e.id} e={e} onOpen={setOpen} />)}
            {!events.length && <p className="col-span-2 py-6 text-center text-sm text-slate-400">Chưa có sự kiện trong 24 giờ qua.</p>}
          </div>
        </Card>
      </div>

      <div className="space-y-4 xl:col-span-4">
        <Card title="Danh sách camera">
          <div className="space-y-2">
            {cams.map((c) => { const st = listStatus(c, health[c.id]?.connection); return (
              <div key={c.id} role="button" tabIndex={0} onClick={() => selectCam(c.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectCam(c.id); } }} className={`flex w-full cursor-pointer items-center gap-3 rounded-xl border p-2 text-left ${c.id === camId ? "border-cyan-400/60 bg-cyan-500/10" : "border-white/10 hover:bg-white/5"}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.thumbnail ?? ""} alt="" className="h-12 w-20 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{c.name}{c.enabled === false && <span className="ml-1 text-xs text-amber-300">(tắt)</span>}</div>
                  <div className="text-xs text-slate-400">{c.location} · {c.sourceType === "webcam" ? "Webcam" : c.sourceType === "rtsp" ? `IP/RTSP${c.sourceHost ? ` · ${c.sourceHost}` : ""}` : "Mô phỏng"}</div>
                </div>
                {canManage && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setSettingsId(c.id); }}
                    data-settings-card={c.id}
                    aria-label={`Cài đặt ${c.name}`}
                    title="Cài đặt"
                    className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-cyan-500/20 hover:text-cyan-200"
                  >
                    <Settings className="h-4 w-4" />
                  </button>
                )}
                <div className="text-right text-[11px]">
                  <div className={`flex items-center justify-end gap-1 ${st.tone === "ok" ? "text-emerald-300" : st.tone === "warn" ? "text-amber-300" : "text-slate-400"}`}>
                    <Wifi className="h-3 w-3" /> {st.label}
                  </div>
                  <div className="text-slate-400">{c.today} hôm nay</div>
                </div>
              </div>
            ); })}
            {!cams.some((c) => c.sourceType !== "demo") && (
              <div className="rounded-xl border border-dashed border-cyan-400/30 bg-cyan-500/5 p-3 text-center">
                <p className="text-xs text-slate-300">Chưa có camera thật — danh sách trên chỉ là nguồn mô phỏng.</p>
                {canManage ? (
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    <button onClick={() => discovery.current?.focusForm()} className="btn btn-primary text-xs"><Plus className="h-3.5 w-3.5" /> Thêm camera RTSP</button>
                    <button onClick={() => discovery.current?.scan()} className="btn btn-ghost text-xs"><RadioTower className="h-3.5 w-3.5" /> Quét ONVIF</button>
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-slate-400">Chỉ owner/operator thêm được camera IP.</p>
                )}
              </div>
            )}
          </div>
        </Card>

        <div className="grid grid-cols-2 gap-3">
          <div className="glass rounded-2xl p-3">
            <Activity className="mb-1 h-5 w-5 text-cyan-300" />
            <div className="text-2xl font-bold">{cam?.recent5m ?? 0}</div>
            <div className="text-xs text-slate-400">Sự kiện 5 phút qua</div>
          </div>
          <div className="glass rounded-2xl p-3">
            <AlertTriangle className="mb-1 h-5 w-5 text-orange-300" />
            <div className="text-2xl font-bold">{alerts.length}</div>
            <div className="text-xs text-slate-400">Cảnh báo 7 ngày</div>
          </div>
        </div>

        {alerts.length > 0 && (
          <Card title="Cảnh báo gần đây">
            <div className="-mx-2 space-y-0.5">{alerts.map((e) => <EventRow key={e.id} e={e} onOpen={setOpen} />)}</div>
          </Card>
        )}

        <Card title={<span className="flex items-center gap-2"><PlusCircle className="h-4 w-4 text-violet-300" /> Tạo sự kiện thủ công</span>}>
          <div className="space-y-2">
            <input value={manual.label} onChange={(e) => setManual({ ...manual, label: e.target.value })} placeholder="Tiêu đề (vd: Giao hàng đến cửa)" className="input" />
            <textarea value={manual.note} onChange={(e) => setManual({ ...manual, note: e.target.value })} placeholder="Ghi chú…" rows={2} className="input" />
            <div className="flex items-center gap-2">
              <select value={manual.priority} onChange={(e) => setManual({ ...manual, priority: e.target.value })} className="input" aria-label="Độ ưu tiên">
                <option value="normal">Bình thường</option>
                <option value="important">Quan trọng</option>
                <option value="critical">Khẩn</option>
              </select>
              <button onClick={createManual} disabled={saving || !manual.label.trim()} className="btn btn-primary">Lưu</button>
            </div>
            <div className="text-[11px] text-slate-400">Sự kiện sẽ gắn với <EventBadge type="manual" /> và camera đang chọn.</div>
          </div>
        </Card>
      </div>
      <EventDetail e={open} onClose={() => setOpen(null)} onSaved={refresh} />
      {(() => { const sc = cams.find((c) => c.id === settingsId); return sc && canManage ? (
        <CameraSettingsDrawer cam={sc} onClose={() => setSettingsId(null)} onSaved={load} />
      ) : null; })()}
    </div>
  );
}
