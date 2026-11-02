"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PlusCircle, Activity, AlertTriangle, Wifi, Plus, RadioTower } from "lucide-react";
import CameraView, { type Cam } from "@/components/CameraView";
import CameraDiscovery, { type DiscoveryControls } from "@/components/CameraDiscovery";
import EventDetail from "@/components/EventDetail";
import { Card, EventRow, type EventItem, EventBadge } from "@/components/ui";
import { api, getDeviceId } from "@/lib/client";

type DashCam = Cam & { today: number; recent5m: number };

export default function CameraPage() {
  const [cams, setCams] = useState<DashCam[]>([]);
  const [camId, setCamId] = useState<number | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [alerts, setAlerts] = useState<EventItem[]>([]);
  const [open, setOpen] = useState<EventItem | null>(null);
  const [manual, setManual] = useState({ label: "", note: "", priority: "normal" });
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState<string>("viewer");
  const discovery = useRef<DiscoveryControls | null>(null);
  const registerDiscovery = useCallback((c: DiscoveryControls | null) => { discovery.current = c; }, []);

  const load = useCallback(async () => {
    const d = await api<{ cameras: DashCam[] }>("/api/dashboard");
    setCams(d.cameras);
    setCamId((c) => c ?? d.cameras[0]?.id ?? null);
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
    if (id) setCamId(id);
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

  // timeline buckets by hour (last 24h)
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const t = new Date(Date.now() - (23 - i) * 3600000);
    const h = t.getHours();
    const items = events.filter((e) => {
      const d = new Date(e.happenedAt);
      return Date.now() - d.getTime() < 24 * 3600000 && d.getHours() === h && Math.abs(d.getTime() - t.getTime()) < 3600000 * 1.01;
    });
    return { h, items };
  });
  const maxB = Math.max(1, ...buckets.map((b) => b.items.length));

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      <div className="space-y-3 xl:col-span-8">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Camera & Quan sát</h1>
          <select value={camId ?? ""} onChange={(e) => setCamId(Number(e.target.value))} className="input w-auto" aria-label="Chọn camera">
            {cams.map((c) => <option key={c.id} value={c.id}>{c.name} – {c.location}</option>)}
          </select>
        </div>
        {cam ? <CameraView cam={cam} onEvent={refresh} /> : <div className="aspect-video animate-pulse rounded-xl bg-slate-800/50" />}
        <CameraDiscovery cameras={cams} onAdded={onCameraAdded} canManage={canManage} onControlsReady={registerDiscovery} />

        <Card title="Dòng thời gian 24 giờ">
          <div className="flex h-20 items-end gap-1">
            {buckets.map((b, i) => (
              <div key={i} className="flex flex-1 flex-col items-center gap-1" title={`${b.h}h: ${b.items.length} sự kiện`}>
                <div className="w-full rounded-t bg-gradient-to-t from-cyan-700 to-cyan-300" style={{ height: `${(b.items.length / maxB) * 60 + (b.items.length ? 3 : 1)}px`, opacity: b.items.length ? 1 : 0.25 }} />
                <span className="text-[8px] text-slate-500">{i % 3 === 0 ? `${b.h}h` : ""}</span>
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
            {cams.map((c) => (
              <button key={c.id} onClick={() => setCamId(c.id)} className={`flex w-full items-center gap-3 rounded-xl border p-2 text-left ${c.id === camId ? "border-cyan-400/60 bg-cyan-500/10" : "border-white/10 hover:bg-white/5"}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={c.thumbnail ?? ""} alt="" className="h-12 w-20 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{c.name}{c.enabled === false && <span className="ml-1 text-xs text-amber-300">(tắt)</span>}</div>
                  <div className="text-xs text-slate-400">{c.location} · {c.sourceType === "webcam" ? "Webcam" : c.sourceType === "rtsp" ? `IP/RTSP${c.sourceHost ? ` · ${c.sourceHost}` : ""}` : "Mô phỏng"}</div>
                </div>
                <div className="text-right text-[11px]">
                  <div className={`flex items-center justify-end gap-1 ${c.sourceType === "rtsp" ? (c.streamName ? "text-emerald-300" : "text-amber-300") : c.status === "online" ? "text-emerald-300" : "text-slate-400"}`}>
                    <Wifi className="h-3 w-3" /> {c.sourceType === "rtsp" ? (c.streamName ? "Đã đăng ký" : "Chưa kết nối") : c.status === "online" ? "Online" : "Offline"}
                  </div>
                  <div className="text-slate-400">{c.today} hôm nay</div>
                </div>
              </button>
            ))}
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
    </div>
  );
}
