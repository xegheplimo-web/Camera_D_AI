"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RadioTower, RefreshCw, Plus, Wifi, ShieldAlert } from "lucide-react";
import { api } from "@/lib/client";

type Device = { ip: string; endpoint: string; name: string; urn: string | null; scopes: string[] };
type CameraRecord = { id: number; sourceType: string; sourceHost?: string | null };

export default function CameraDiscovery({ cameras, onAdded }: { cameras: CameraRecord[]; onAdded: () => void }) {
  const [canManage, setCanManage] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [scanState, setScanState] = useState<"idle" | "scanning" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ name: "", location: "", rtspUrl: "" });
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);

  const scan = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setScanState("scanning");
    try {
      const result = await api<{ items: Device[]; notice: string }>("/api/cameras/discover", { method: "POST", json: {} });
      setDevices(result.items);
      setMessage(result.items.length ? `Đã tìm thấy ${result.items.length} camera ONVIF trong mạng LAN.` : "Chưa phát hiện camera ONVIF. Có thể thiết bị không bật ONVIF hoặc multicast bị chặn.");
      setScanState("done");
    } catch (error) {
      const txt = error instanceof Error ? error.message : "Không thể quét mạng LAN";
      setMessage(txt);
      setScanState("error");
    } finally { pending.current = false; }
  }, []);

  useEffect(() => {
    let active = true;
    api<{ role: string }>("/api/settings").then((r) => {
      if (active && (r.role === "owner" || r.role === "operator")) setCanManage(true);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!canManage) return;
    // Automatically discover on page load and once every 60 s. Do not automatically enroll devices.
    const t = setTimeout(() => scan(), 300);
    const repeat = setInterval(() => scan(), 60_000);
    return () => { clearTimeout(t); clearInterval(repeat); };
  }, [canManage, scan]);

  const choose = (d: Device) => {
    setForm({ name: d.name || `Camera ${d.ip}`, location: "LAN", rtspUrl: `rtsp://${d.ip}:554/` });
    setMessage(`Camera ${d.ip} được tìm thấy tại ${d.endpoint}. Hãy sửa đường dẫn RTSP theo hướng dẫn của thiết bị và nhập tài khoản, mật khẩu hợp lệ trước khi lưu.`);
  };

  const addCamera = async () => {
    if (!form.name.trim() || !form.location.trim() || !form.rtspUrl.trim()) return;
    setSaving(true);
    try {
      const result = await api<{ warning?: string; sourceHint?: string }>("/api/cameras", { method: "POST", json: { ...form, sourceType: "rtsp" } });
      setMessage(result.warning || `Đã thêm camera ${result.sourceHint || ""}. Mở xem để kiểm tra hình ảnh.`);
      setForm({ name: "", location: "", rtspUrl: "" });
      onAdded();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Không thêm được camera"); }
    finally { setSaving(false); }
  };

  return (
    <section className="glass space-y-3 rounded-2xl p-4" aria-label="Tự phát hiện và thêm camera LAN">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold"><RadioTower className="h-5 w-5 text-cyan-300" /> Tự động tìm camera cùng mạng LAN</h2>
        <button onClick={scan} disabled={!canManage || scanState === "scanning"} className="btn btn-ghost text-xs"><RefreshCw className={`h-4 w-4 ${scanState === "scanning" ? "animate-spin" : ""}`} /> Quét lại</button>
      </div>
      <p className="text-xs text-[#a9bad2]">Tự quét ONVIF khi mở trang và mỗi 60 giây trên máy chủ Windows. Không tự thêm camera khi chưa được chủ thiết bị cho phép. Tìm kiếm chỉ trong LAN; không quét Internet.</p>
      {!canManage ? <p className="text-xs text-amber-200"><ShieldAlert className="mr-1 inline h-4 w-4"/>Chỉ owner/operator được quét và thêm camera.</p> : null}
      {message && <p className="rounded-lg bg-slate-800/70 p-2 text-xs" role="status">{message}</p>}
      <div className="space-y-2">
        {devices.map((d) => {
          const saved = cameras.some((c) => c.sourceHost?.startsWith(`${d.ip}:`));
          return <div key={d.ip + d.endpoint} className="flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2">
            <Wifi className="h-4 w-4 text-cyan-300" />
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{d.name}</div><div className="text-xs text-[#a9bad2]">{d.ip} · ONVIF {saved ? "· đã có trong danh sách" : "· mới phát hiện"}</div></div>
            <button onClick={() => choose(d)} disabled={!canManage} className="btn btn-ghost text-xs">{saved ? "Cấu hình" : "Chọn"}</button>
          </div>;
        })}
      </div>
      {canManage && <div className="space-y-2 rounded-xl border border-white/10 p-3">
        <h3 className="text-sm font-semibold">Thêm bằng địa chỉ IP / RTSP</h3>
        <p className="text-xs text-amber-200">Tìm thấy ONVIF không đồng nghĩa đã biết RTSP. Đường dẫn chính xác và tài khoản cần lấy từ camera/nhà sản xuất. Mật khẩu được mã hóa tại máy chủ.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input className="input" aria-label="Tên camera IP" placeholder="Tên camera" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" aria-label="Vị trí camera IP" placeholder="Vị trí" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </div>
        <input className="input font-mono text-xs" type="password" aria-label="Địa chỉ RTSP bao gồm tài khoản mật khẩu nếu có" placeholder="rtsp://user:password@192.168.1.100:554/stream1" autoComplete="off" value={form.rtspUrl} onChange={(e) => setForm({ ...form, rtspUrl: e.target.value })} />
        <button className="btn btn-primary" onClick={addCamera} disabled={saving || !form.name.trim() || !form.location.trim() || !form.rtspUrl.trim()}><Plus className="h-4 w-4" /> {saving ? "Đang lưu…" : "Thêm camera IP"}</button>
      </div>}
    </section>
  );
}
