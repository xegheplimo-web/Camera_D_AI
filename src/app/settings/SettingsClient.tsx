"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Video, Volume2, Smartphone, ShieldCheck, Trash2, Plus, Cpu, CheckCircle2, Circle, Users, HardDrive, Pencil, Camera } from "lucide-react";
import { Card, Badge, Modal } from "@/components/ui";
import { useApp } from "@/components/AppState";
import { api, getDeviceId } from "@/lib/client";
import { NoPermissionState } from "@/components/states";
import AdminPanel from "./AdminPanel";
import type { Admin, Cam, RecStorage, Settings } from "./types";

function fmtBytes(b: number): string {
  return b >= 1 << 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${(b / 2 ** 20).toFixed(1)} MB`;
}

export default function SettingsClient({ initialRole }: { initialRole: string }) {
  const { voiceOut, setVoiceOut, rate, setRate, speak, hasViVoice } = useApp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [cams, setCams] = useState<Cam[]>([]);
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [role, setRole] = useState<string>(initialRole);
  const [editCamId, setEditCamId] = useState<number | null>(null);
  const [camDraft, setCamDraft] = useState({ name: "", location: "", enabled: true, retentionDays: "" });
  const [phrase, setPhrase] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [demoConfirm, setDemoConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recStorage, setRecStorage] = useState<RecStorage | null>(null);
  const [recDays, setRecDays] = useState("7");

  const load = useCallback(() => {
    api<Cam[]>("/api/cameras").then(setCams).catch(() => {});
    api<{ settings: Settings; role: string }>("/api/settings").then((r) => {
      setSettings(r.settings); setRole(r.role);
      if (r.role === "owner" || r.role === "operator") api<Admin>("/api/admin").then(setAdmin).catch(() => setAdmin(null));
      else setAdmin(null);
    }).catch(() => {});
    api<{ storage: RecStorage }>("/api/recordings").then((r) => setRecStorage(r.storage)).catch(() => setRecStorage(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  // T-1305b: trả kết quả để caller biết PATCH thành công hay không (purge chỉ báo "đã tắt" khi cả 2 bước OK).
  const patchSettings = async (patch: Partial<Settings>): Promise<boolean> => {
    setErr(null);
    try {
      const r = await api<{ settings: Settings }>("/api/settings", { method: "PATCH", json: patch });
      setSettings(r.settings);
      setMsg("Đã lưu cài đặt.");
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không lưu được");
      return false;
    }
  };

  const startEditCam = (c: Cam) => {
    setEditCamId(c.id);
    setCamDraft({ name: c.name, location: c.location, enabled: c.enabled, retentionDays: c.retentionDays == null ? "" : String(c.retentionDays) });
  };

  const saveCam = async (id: number) => {
    setErr(null);
    try {
      await api(`/api/cameras/${id}`, {
        method: "PATCH",
        json: { name: camDraft.name, location: camDraft.location, enabled: camDraft.enabled, retentionDays: camDraft.retentionDays === "" ? null : Number(camDraft.retentionDays) },
      });
      setEditCamId(null);
      setMsg("Đã lưu camera.");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không lưu được camera");
    }
  };

  const delCam = async (c: Cam) => {
    if (!confirm(`Xoá camera "${c.name}" (${c.code})?\n\nSẽ gỡ stream go2rtc và đường dẫn nguồn đã lưu (mã hoá). Nếu còn sự kiện hoặc ảnh liên quan, hệ thống sẽ hỏi thêm trước khi xoá.`)) return;
    setErr(null);
    try {
      const run = async (cascade: boolean): Promise<{ eventsRemoved?: number } | null> => {
        const res = await fetch(`/api/cameras/${c.id}?confirm=yes${cascade ? "&cascade=yes" : ""}`, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409 && !cascade) {
          if (confirm(`Camera còn ${data.events ?? "?"} sự kiện tham chiếu (ảnh bằng chứng gắn sẽ mất liên kết camera). Xoá kèm toàn bộ sự kiện đó?`)) return run(true);
          return null;
        }
        if (!res.ok) throw new Error([data.title, data.detail].filter(Boolean).join(": ") || `Lỗi ${res.status}`);
        return data;
      };
      const r = await run(false);
      if (r) {
        setMsg(`Đã xoá camera ${c.code}${r.eventsRemoved ? ` kèm ${r.eventsRemoved} sự kiện` : ""}.`);
        load();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không xoá được camera");
    }
  };

  // T-1305: tắt demo lần đầu (còn dữ liệu mẫu trong DB) → hỏi xác nhận trước.
  const onToggleDemo = (next: boolean) => {
    if (!next && (admin?.demoEvents ?? 0) > 0 && !localStorage.getItem("dai_demo_off_confirmed")) {
      setDemoConfirm(true);
      return;
    }
    void patchSettings({ demoMode: next });
  };

  const confirmDisableKeep = async () => {
    localStorage.setItem("dai_demo_off_confirmed", "1");
    setDemoConfirm(false);
    await patchSettings({ demoMode: false });
  };

  // Nút trong dialog xác nhận: purge ngay qua POST /api/admin (owner), rồi tắt demoMode.
  const purgeDemoNow = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ events?: number; extractions?: number; assets?: number; bytes?: number }>("/api/admin", {
        method: "POST",
        json: { action: "purge_demo", confirmPhrase: "XOA DU LIEU", deviceId: getDeviceId() },
      });
      localStorage.setItem("dai_demo_off_confirmed", "1");
      setDemoConfirm(false);
      if (await patchSettings({ demoMode: false })) {
        setMsg(`Đã xoá ${r.events ?? 0} sự kiện, ${r.extractions ?? 0} trích xuất, ${r.assets ?? 0} ảnh mẫu (${((r.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB) và tắt dữ liệu mẫu. Nhật ký đã ghi lại.`);
      } else {
        setErr("Đã xoá dữ liệu mẫu nhưng chưa tắt được chế độ mẫu — thử lại.");
      }
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không xoá được dữ liệu mẫu");
    } finally {
      setBusy(false);
    }
  };

  const adminAction = async (action: string, label: string, extra = "") => {
    if (phrase !== "XOA DU LIEU") return setErr("Nhập đúng cụm “XOA DU LIEU” để xác nhận.");
    if (!confirm(`${label}? Hành động không thể hoàn tác.${extra}`)) return;
    try {
      const r = await api<{ ok: boolean; events?: number; extractions?: number; assets?: number; bytes?: number; demoReseeded?: boolean }>("/api/admin", { method: "POST", json: { action, confirmPhrase: phrase, deviceId: getDeviceId() } });
      setMsg(action === "purge_demo"
        ? `Đã xoá ${r.events ?? 0} sự kiện, ${r.extractions ?? 0} trích xuất, ${r.assets ?? 0} ảnh mẫu (${((r.bytes ?? 0) / 1024 / 1024).toFixed(1)} MB). Nhật ký đã ghi lại.`
        : action === "reset_all"
          ? r.demoReseeded
            ? "Đã đặt lại và tạo dữ liệu mẫu. Nhật ký đã ghi lại."
            : "Đã đặt lại. Hệ thống trống — thêm camera thật hoặc bật CAMDAI_DEMO_SEED để có dữ liệu mẫu."
          : "Đã thực hiện. Nhật ký đã ghi lại thao tác.");
      setPhrase("");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không thực hiện được");
    }
  };

  const canManage = role === "owner" || role === "operator";
  const isOwner = role === "owner";
  // SSR phải khớp client lần render đầu — "—" phía server, mã thật sau hydrate (tránh React #418).
  const deviceId = useSyncExternalStore(() => () => {}, () => getDeviceId(), () => "—");
  const tab = canManage && searchParams.get("tab") === "admin" ? "admin" : "settings";
  const selectTab = (t: "settings" | "admin") => router.replace(t === "admin" ? "/settings?tab=admin" : "/settings", { scroll: false });
  const wizard = [
    { done: cams.length > 0, label: "Kết nối camera (RTSP, webcam hoặc nguồn mô phỏng)", href: "#cameras" },
    { done: true, label: "Kiểm tra loa: nghe thử giọng D-AI Bot", href: "#audio" },
    { done: !settings?.demoMode, label: "Tắt dữ liệu mẫu trước khi dùng thật", href: "/settings?tab=admin#data" },
    { done: !!admin, label: "Duyệt thiết bị và phiên đăng nhập", href: "#devices" },
    { done: !!(admin && admin.logs.length > 0), label: "Xem nhật ký thao tác đầu tiên", href: "/settings?tab=admin#audit" },
  ];
  const wizardList = (
    <ul className="space-y-1.5 text-sm">
      {wizard.map((w) => (
        <li key={w.label} className="flex items-center gap-2">
          {w.done ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <Circle className="h-4 w-4 text-slate-500" />}
          <a href={w.href} className={w.done ? "text-[#a9bad2] line-through" : "text-white hover:text-cyan-300"}>{w.label}</a>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Cài đặt</h1>
        <Badge color={isOwner ? "emerald" : canManage ? "cyan" : "slate"}>{admin?.me.role ?? role}</Badge>
        <span className="text-xs text-[#a9bad2]">Sinh trắc/thiết bị không được dùng làm bằng chứng xác thực — mọi hành động dựa trên phiên đăng nhập.</span>
      </div>
      {msg && <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{msg}</div>}
      {err && <div className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100" role="alert">{err}</div>}

      <div role="tablist" aria-label="Nhóm cài đặt" className="flex gap-2">
        <button type="button" role="tab" id="tab-settings" aria-selected={tab === "settings"} aria-controls="panel-settings" onClick={() => selectTab("settings")} className={`btn flex-1 ${tab === "settings" ? "btn-primary" : "btn-ghost"}`}>Cài đặt</button>
        {canManage && (
          <button type="button" role="tab" id="tab-admin" aria-selected={tab === "admin"} aria-controls="panel-admin" onClick={() => selectTab("admin")} className={`btn flex-1 ${tab === "admin" ? "btn-primary" : "btn-ghost"}`}>Quản trị</button>
        )}
      </div>

      {tab === "settings" ? (
        <div role="tabpanel" id="panel-settings" aria-labelledby="tab-settings" className="space-y-4">
          {cams.length > 0 ? (
            <details className="glass p-4">
              <summary className="cursor-pointer select-none text-sm text-[#a9bad2]">Thiết lập ban đầu đã xong · <span className="text-cyan-300">Xem lại</span></summary>
              <div className="mt-2">{wizardList}</div>
            </details>
          ) : (
            <Card title="Thiết lập lần đầu">{wizardList}</Card>
          )}

          <div className="grid gap-4 xl:grid-cols-2">
            <Card title={<span id="cameras" className="flex items-center gap-2"><Video className="h-4 w-4 text-cyan-300" /> Camera</span>}>
              <div className="space-y-2">
                {cams.map((c) => (
                  <div key={c.id} className="rounded-xl border border-white/10 p-2">
                    {editCamId === c.id ? (
                      <div className="space-y-2">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <input value={camDraft.name} onChange={(e) => setCamDraft({ ...camDraft, name: e.target.value })} placeholder="Tên camera" className="input" />
                          <input value={camDraft.location} onChange={(e) => setCamDraft({ ...camDraft, location: e.target.value })} placeholder="Vị trí" className="input" />
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs">
                          <label className="flex items-center gap-1.5"><input type="checkbox" checked={camDraft.enabled} onChange={(e) => setCamDraft({ ...camDraft, enabled: e.target.checked })} className="accent-cyan-400" /> Bật</label>
                          <label className="flex items-center gap-1.5">Giữ sự kiện (ngày)
                            <input type="number" min={1} max={365} value={camDraft.retentionDays} onChange={(e) => setCamDraft({ ...camDraft, retentionDays: e.target.value })} placeholder="mặc định" className="input w-24" />
                          </label>
                          <span className="text-[#a9bad2]">để trống = theo cài đặt chung</span>
                          <span className="flex-1" />
                          <button onClick={() => saveCam(c.id)} className="btn btn-primary text-xs">Lưu</button>
                          <button onClick={() => setEditCamId(null)} className="btn btn-ghost text-xs">Huỷ</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        {c.thumbnail ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img src={c.thumbnail} alt="" className="h-10 w-16 rounded-lg object-cover" />
                        ) : (
                          <div className="flex h-10 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-700/60 text-slate-400"><Camera className="h-4 w-4" /></div>
                        )}
                        <div className="flex-1">
                          <div className="text-sm font-semibold">{c.code} · {c.name}{!c.enabled && <span className="ml-1 text-amber-300">(tắt)</span>}</div>
                          <div className="text-xs text-[#a9bad2]">{c.location}{c.retentionDays ? ` · giữ ${c.retentionDays}d` : ""}{c.sourceType === "rtsp" && c.sourceHost ? ` · ${c.sourceHost}` : ""}</div>
                        </div>
                        <Badge color={c.sourceType === "webcam" ? "cyan" : c.sourceType === "rtsp" ? "sky" : "slate"}>{c.sourceType === "webcam" ? "Webcam" : c.sourceType === "rtsp" ? "IP/RTSP" : "Mô phỏng"}</Badge>
                        <Badge color={c.status === "demo" ? "slate" : c.status === "online" ? "emerald" : c.status === "degraded" ? "sky" : "amber"}>{c.status === "demo" ? "demo" : c.status === "degraded" ? "đã đăng ký" : c.status}</Badge>
                        {canManage && (
                          <button onClick={() => startEditCam(c)} className="btn btn-ghost px-2 py-1 text-xs" aria-label={`Sửa ${c.name}`} title="Sửa camera"><Pencil className="h-3.5 w-3.5" /></button>
                        )}
                        {isOwner && (
                          <button onClick={() => delCam(c)} className="btn btn-ghost px-2 py-1 text-xs text-rose-300" aria-label={`Xoá ${c.name}`} title="Xoá camera"><Trash2 className="h-3.5 w-3.5" /></button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {!canManage ? (
                <div className="mt-3"><NoPermissionState what="quản lý camera" /></div>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Link href="/camera" className="btn btn-primary"><Plus className="h-4 w-4" /> Thêm camera</Link>
                  <span className="text-[11px] text-[#a9bad2]">Thêm camera IP/RTSP (quét ONVIF hoặc nhập URL), webcam và nguồn mô phỏng tại trang Camera.</span>
                </div>
              )}
              <p className="mt-2 text-[11px] text-[#a9bad2]">Ghi hình 24/7 khi đóng trình duyệt <b className="text-amber-300">chưa hỗ trợ</b> trong bản web này; cần dịch vụ nền trên Windows (giai đoạn G3).</p>
            </Card>

            <Card title={<span className="flex items-center gap-2"><Cpu className="h-4 w-4 text-cyan-300" /> Tính năng AI</span>}>
              <div className="space-y-3 text-sm">
                <label className="flex items-start gap-2 rounded-xl border border-white/10 p-2">
                  <input type="checkbox" checked={settings?.detectEnabled ?? false} disabled={!canManage} onChange={(e) => patchSettings({ detectEnabled: e.target.checked })} className="mt-0.5 accent-cyan-400" />
                  <span>
                    <b>Phát hiện chuyển động từ camera</b>
                    <span className="block text-xs text-[#a9bad2]">Tự động ghi nhận sự kiện khi có chuyển động trong khung hình; phân tích chạy trên máy chủ và có khoảng nghỉ giữa các lần ghi cho mỗi camera.</span>
                  </span>
                </label>
              </div>
            </Card>

            <Card title={<span id="audio" className="flex items-center gap-2"><Volume2 className="h-4 w-4 text-violet-300" /> Giọng nói & âm thanh</span>}>
              <div className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setVoiceOut("device")} className={`btn ${voiceOut === "device" ? "btn-primary" : "btn-ghost"}`}>Phát qua loa máy này</button>
                  <button onClick={() => setVoiceOut("text")} className={`btn ${voiceOut === "text" ? "btn-primary" : "btn-ghost"}`}>Chỉ hiện chữ</button>
                </div>
                <label className="block text-xs text-[#a9bad2]">Tốc độ đọc {rate.toFixed(1)}x
                  <input type="range" min={0.6} max={1.6} step={0.1} value={rate} onChange={(e) => setRate(Number(e.target.value))} className="mt-1 w-full accent-cyan-400" />
                </label>
                <button onClick={() => speak("Xin chào! Đây là giọng nói của D-AI Bot trên thiết bị này.")} className="btn btn-ghost">Nghe thử loa</button>
                <ul className="space-y-1 text-xs text-[#a9bad2]">
                  <li>• Mặc định phát trên <b className="text-white">thiết bị gửi câu hỏi</b>; máy chủ không tự phát loa thiết bị khác.</li>
                  <li>• Mic chỉ bật khi bạn nhấn; không có nghe nền hay wake word.</li>
                  <li>• Giọng dự phòng của thiết bị: {hasViVoice ? <span className="text-emerald-300">có sẵn</span> : <span className="text-amber-300">chưa có — dùng giọng mặc định</span>}</li>
                  <li>• Phát trên thiết bị khác: <b className="text-amber-300">chưa hỗ trợ</b> (cần ghép đôi + đồng ý + quyền owner).</li>
                </ul>
              </div>
            </Card>

            <Card title={<span className="flex items-center gap-2"><HardDrive className="h-4 w-4 text-sky-300" /> Lưu trữ & Xem lại</span>}>
              {recStorage ? (
                <div className="rounded-xl border border-white/10 p-2 text-xs text-[#a9bad2]">
                  <b className="text-white">Bản ghi video:</b> {fmtBytes(recStorage.totalBytes)} trên {recStorage.cameras.length} nguồn
                  {recStorage.freeBytes !== null && <> · đĩa trống ≈{fmtBytes(recStorage.freeBytes)}</>}
                  {recStorage.cameras.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {recStorage.cameras.map((c) => (
                        <li key={c.key} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate font-mono">{c.key}</span>
                          <span className="shrink-0">{c.segments} đoạn · {fmtBytes(c.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {isOwner && recStorage.cameras.length > 0 && (
                    <div className="mt-2 flex items-center gap-2">
                      <span>Xoá bản ghi cũ hơn</span>
                      <input type="number" min={1} max={365} value={recDays} onChange={(e) => setRecDays(e.target.value)} className="input w-16 py-0.5" aria-label="Số ngày giữ lại" />
                      <span>ngày</span>
                      <button onClick={async () => {
                        const n = Number(recDays);
                        if (!Number.isSafeInteger(n) || n < 1 || n > 365) return setErr("Số ngày phải là số nguyên 1–365.");
                        if (!confirm(`Xoá vĩnh viễn mọi bản ghi video cũ hơn ${n} ngày? Hành động không thể hoàn tác.`)) return;
                        setErr(null); setBusy(true);
                        try {
                          const r = await api<{ deleted: number; bytes: number }>(`/api/recordings?olderThanDays=${n}`, { method: "DELETE" });
                          setMsg(`Đã xoá ${r.deleted} đoạn bản ghi (${fmtBytes(r.bytes)}). Nhật ký đã ghi lại.`);
                          load();
                        } catch (e) { setErr(e instanceof Error ? e.message : "Không xoá được bản ghi"); }
                        finally { setBusy(false); }
                      }} disabled={busy} className="btn btn-ghost py-1"><Trash2 className="h-3.5 w-3.5" /> Xoá</button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-[#a9bad2]">Chưa tải được dữ liệu lưu trữ.</p>
              )}
            </Card>

            <Card title={<span id="devices" className="flex items-center gap-2"><Users className="h-4 w-4 text-sky-300" /> Phiên & thiết bị</span>}>
              <p className="mb-2 text-xs text-[#a9bad2]">Mã thiết bị trình duyệt: <span className="font-mono text-cyan-200">{deviceId}</span> (chỉ để hiển thị, không dùng xác thực).</p>
              {admin?.sessions?.length ? (
                <div className="scroll-thin max-h-56 space-y-1 overflow-auto text-xs" tabIndex={0} role="region" aria-label="Danh sách phiên đăng nhập">
                  {admin.sessions.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 rounded-lg border border-white/10 px-2 py-1">
                      <Smartphone className="h-4 w-4 text-slate-400" />
                      <span className="min-w-0 flex-1 truncate">{s.user ?? "?"} · {s.role} · {s.device}</span>
                      <span className="text-[#a9bad2]">{s.revokedAt ? "đã thu hồi" : new Date(s.lastSeenAt).toLocaleDateString("vi-VN")}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[#a9bad2]">Chỉ chủ hệ thống hoặc vận hành xem được danh sách phiên.</p>
              )}
              {isOwner && (
                <button onClick={() => adminAction("revoke_sessions", "Thu hồi mọi phiên khác")} className="btn btn-ghost mt-2 text-xs">Thu hồi các phiên khác</button>
              )}
            </Card>

            <Card title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-300" /> Quyền riêng tư & bảo mật</span>}>
              <p className="text-sm text-[#c6d4e6]">Dữ liệu camera/ảnh/âm thanh chỉ hiển thị cho phiên đã đăng nhập. Micro chỉ bật khi bạn yêu cầu. Bạn có thể xem, xuất và xóa lịch sử tại đây.</p>
              <ul className="mt-2 space-y-1 text-xs text-[#a9bad2]">
                <li>• Mọi API (trừ đăng nhập và healthcheck) đều yêu cầu phiên hợp lệ; cookie ký HMAC, httpOnly.</li>
                <li>• Vai trò: owner (toàn quyền) · operator (vận hành, không xóa dữ liệu) · viewer (chỉ xem/hỏi).</li>
                <li>• Nhật ký ghi người thực hiện, vai trò, thiết bị và đối tượng — không dùng deviceId từ trình duyệt làm danh tính.</li>
                <li>• Chưa có nhận diện danh tính khuôn mặt; chỉ theo dõi đối tượng vô danh.</li>
              </ul>
            </Card>
          </div>
        </div>
      ) : (
        <div role="tabpanel" id="panel-admin" aria-labelledby="tab-admin">
          <AdminPanel isOwner={isOwner} admin={admin} settings={settings} patchSettings={patchSettings} onToggleDemo={onToggleDemo} phrase={phrase} setPhrase={setPhrase} adminAction={adminAction} />
        </div>
      )}

      <Modal open={demoConfirm} onClose={() => setDemoConfirm(false)} title="Tắt dữ liệu mẫu?">
        <p className="text-sm text-[#c6d4e6]">Tắt dữ liệu mẫu sẽ ẩn toàn bộ event demo khỏi báo cáo. Dữ liệu demo vẫn còn trong DB cho tới khi xoá.</p>
        <p className="mt-2 text-xs text-[#a9bad2]">Hiện có <b className="text-amber-200">{admin?.demoEvents ?? "–"}</b> sự kiện mẫu trong DB. Bạn có thể chỉ ẩn chúng, hoặc xoá vĩnh viễn ngay bây giờ.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={confirmDisableKeep} disabled={busy} className="btn btn-primary">Tắt &amp; giữ dữ liệu trong DB</button>
          {isOwner && <button onClick={purgeDemoNow} disabled={busy} className="btn btn-danger"><Trash2 className="h-4 w-4" /> Xoá dữ liệu mẫu</button>}
          <button onClick={() => setDemoConfirm(false)} disabled={busy} className="btn btn-ghost">Huỷ</button>
        </div>
        {!isOwner && <p className="mt-2 text-[11px] text-[#a9bad2]">Chỉ chủ hệ thống (owner) xoá được dữ liệu mẫu.</p>}
      </Modal>
    </div>
  );
}
