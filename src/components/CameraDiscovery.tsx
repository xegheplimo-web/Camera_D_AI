"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RadioTower, RefreshCw, Plus, Wifi, ShieldAlert } from "lucide-react";
import { api } from "@/lib/client";
import { isLanRtspHost, isLinkLocalIPv4 } from "@/lib/camera/ipv4";

type Device = { ip: string; endpoint: string; name: string; urn: string | null; scopes: string[] };
type CameraRecord = { id: number; sourceType: string; sourceHost?: string | null };

export type DiscoveryControls = { scan: () => void; focusForm: () => void };

/** Cùng module luật với validateCameraUrl() server-side (src/lib/camera/ipv4) — kiểm tra sớm phía client. */
function rtspInputError(value: string): string | null {
  const raw = value.trim();
  if (!raw) return "Nhập địa chỉ RTSP của camera.";
  if (raw.length > 2048 || /[\r\n]/.test(raw)) return "Địa chỉ RTSP không hợp lệ.";
  let u: URL;
  try { u = new URL(raw); } catch { return "Địa chỉ RTSP không hợp lệ."; }
  if (u.protocol !== "rtsp:" && u.protocol !== "rtsps:") return "Chỉ hỗ trợ URL bắt đầu bằng rtsp:// hoặc rtsps://.";
  if (isLinkLocalIPv4(u.hostname)) return "Địa chỉ link-local (169.254.x.x) không được phép cho nguồn RTSP.";
  if (!isLanRtspHost(u.hostname)) return "Chỉ hỗ trợ IPv4 LAN riêng (10.x, 172.16–31.x, 192.168.x) — không nhận hostname, IP public, loopback hay CGNAT.";
  if (u.port && (+u.port < 1 || +u.port > 65535)) return "Cổng camera không hợp lệ.";
  if (u.hash) return "RTSP URL không hỗ trợ fragment (#…).";
  return null;
}

/** Chờ chunk đầu của luồng MJPEG — đăng ký go2rtc thành công chưa chắc có hình; probe này xác minh thật. */
async function probeStream(id: number, timeoutMs = 15_000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/cameras/${id}/stream`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok || !res.body) return false;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    await reader.cancel().catch(() => {});
    return !!value?.length;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default function CameraDiscovery({ cameras, onAdded, canManage, onControlsReady }: { cameras: CameraRecord[]; onAdded: (id?: number) => void; canManage: boolean; onControlsReady?: (c: DiscoveryControls | null) => void }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [scanState, setScanState] = useState<"idle" | "scanning" | "done" | "error">("idle");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", location: "", sourceType: "rtsp", rtspUrl: "" });
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  const scan = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setScanState("scanning");
    try {
      const result = await api<{ items: Device[]; notice: string }>("/api/cameras/discover", { method: "POST", json: {} });
      setDevices(result.items);
      setNotice(result.items.length ? `Đã tìm thấy ${result.items.length} camera ONVIF trong mạng LAN.` : "Chưa phát hiện camera ONVIF. Có thể thiết bị không bật ONVIF hoặc multicast bị chặn.");
      setScanState("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không thể quét mạng LAN");
      setScanState("error");
    } finally { pending.current = false; }
  }, []);

  useEffect(() => {
    if (!onControlsReady) return;
    onControlsReady({
      scan: () => void scan(),
      focusForm: () => {
        formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        urlRef.current?.focus();
      },
    });
    return () => onControlsReady(null);
  }, [onControlsReady, scan]);

  useEffect(() => {
    if (!canManage) return;
    // Automatically discover on page load and once every 60 s. Do not automatically enroll devices.
    const t = setTimeout(() => scan(), 300);
    const repeat = setInterval(() => scan(), 60_000);
    return () => { clearTimeout(t); clearInterval(repeat); };
  }, [canManage, scan]);

  const choose = (d: Device) => {
    setForm({ name: d.name || `Camera ${d.ip}`, location: "LAN", sourceType: "rtsp", rtspUrl: `rtsp://${d.ip}:554/` });
    setNotice(`Camera ${d.ip} được tìm thấy tại ${d.endpoint}. Hãy sửa đường dẫn RTSP theo hướng dẫn của thiết bị và nhập tài khoản, mật khẩu hợp lệ trước khi lưu.`);
  };

  const addCamera = async () => {
    setError("");
    setNotice("");
    const name = form.name.trim();
    const location = form.location.trim();
    const sourceType = form.sourceType;
    if (!name || !location) return setError("Nhập đủ tên và vị trí camera.");
    if (sourceType === "rtsp") {
      const bad = rtspInputError(form.rtspUrl);
      if (bad) return setError(bad);
    }
    setSaving(true);
    try {
      const result = await api<{ id: number; connected?: boolean; warning?: string; sourceHint?: string | null }>("/api/cameras", {
        method: "POST",
        json: { name, location, sourceType, ...(sourceType === "rtsp" ? { rtspUrl: form.rtspUrl.trim() } : {}) },
      });
      setForm({ name: "", location: "", sourceType: "rtsp", rtspUrl: "" });
      onAdded(result.id);
      if (sourceType !== "rtsp") {
        setNotice(`Đã thêm camera ${name}.`);
      } else if (!result.connected) {
        setError(result.warning || "Đã lưu camera nhưng chưa kết nối được go2rtc. Bật go2rtc rồi dùng nút “Kết nối lại” trên khung hình.");
      } else {
        setNotice(`Đã kết nối nguồn hình cho ${result.sourceHint ?? "camera IP"} — đang xác minh hình ảnh…`);
        const ok = await probeStream(result.id);
        if (ok) setNotice(`Đã thêm ${result.sourceHint ?? "camera IP"} — kết nối thành công, stream đang có hình.`);
        else setError(`Đã lưu ${result.sourceHint ?? "camera"} nhưng chưa nhận được hình sau 15 giây. Kiểm tra lại đường RTSP/nguồn camera, rồi bấm “Kết nối lại” trên khung hình.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không thêm được camera");
    } finally { setSaving(false); }
  };

  return (
    <section className="glass space-y-3 rounded-2xl p-4" aria-label="Tự phát hiện và thêm camera LAN">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold"><RadioTower className="h-5 w-5 text-cyan-300" /> Tự động tìm camera cùng mạng LAN</h2>
        {canManage && <button onClick={scan} disabled={scanState === "scanning"} className="btn btn-ghost text-xs"><RefreshCw className={`h-4 w-4 ${scanState === "scanning" ? "animate-spin" : ""}`} /> Quét lại</button>}
      </div>
      <p className="text-xs text-[#a9bad2]">Tự quét ONVIF khi mở trang và mỗi 60 giây trên máy chủ Windows. Không tự thêm camera khi chưa được chủ thiết bị cho phép. Tìm kiếm chỉ trong LAN; không quét Internet.</p>
      {!canManage ? <p className="text-xs text-amber-200"><ShieldAlert className="mr-1 inline h-4 w-4" />Chỉ owner/operator được quét và thêm camera.</p> : null}
      {error && <p className="rounded-lg border border-rose-400/40 bg-rose-500/10 p-2 text-xs text-rose-100" role="alert">{error}</p>}
      {notice && <p className="rounded-lg bg-slate-800/70 p-2 text-xs" role="status">{notice}</p>}
      <div className="space-y-2">
        {devices.map((d) => {
          const saved = cameras.some((c) => c.sourceHost?.startsWith(`${d.ip}:`));
          return <div key={d.ip + d.endpoint} className="flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2">
            <Wifi className="h-4 w-4 text-cyan-300" />
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{d.name}</div><div className="text-xs text-[#a9bad2]">{d.ip} · ONVIF {saved ? "· đã có trong danh sách" : "· mới phát hiện"}</div></div>
            {canManage && <button onClick={() => choose(d)} className="btn btn-ghost text-xs">{saved ? "Cấu hình" : "Chọn"}</button>}
          </div>;
        })}
      </div>
      {canManage && <div ref={formRef} className="space-y-2 rounded-xl border border-white/10 p-3">
        <h3 className="text-sm font-semibold">Thêm camera thủ công</h3>
        <p className="text-xs text-amber-200">Tìm thấy ONVIF không đồng nghĩa đã biết RTSP. Đường dẫn chính xác và tài khoản cần lấy từ camera/nhà sản xuất. Mật khẩu được mã hóa tại máy chủ.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <input className="input" aria-label="Tên camera" placeholder="Tên camera" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" aria-label="Vị trí camera" placeholder="Vị trí" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          <select className="input" aria-label="Nguồn camera" value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value })}>
            <option value="rtsp">RTSP/IP</option>
            <option value="webcam">Webcam</option>
            <option value="demo">Mô phỏng</option>
          </select>
        </div>
        {form.sourceType === "rtsp" && (
          <input ref={urlRef} className="input font-mono text-xs" type="password" aria-label="Địa chỉ RTSP bao gồm tài khoản mật khẩu nếu có" placeholder="rtsp://192.168.1.50:554/stream1" autoComplete="off" value={form.rtspUrl} onChange={(e) => setForm({ ...form, rtspUrl: e.target.value })} />
        )}
        <button className="btn btn-primary" onClick={addCamera} disabled={saving || !form.name.trim() || !form.location.trim() || (form.sourceType === "rtsp" && !form.rtspUrl.trim())}><Plus className="h-4 w-4" /> {saving ? "Đang lưu…" : "Thêm camera"}</button>
      </div>}
    </section>
  );
}
