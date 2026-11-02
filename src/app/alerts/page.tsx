"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, CheckCheck, ShieldAlert, Plus, Trash2, BellOff } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, Card, EventRow, type EventItem } from "@/components/ui";
import EventDetail from "@/components/EventDetail";
import { EmptyState, ErrorState, LoadingState, NoPermissionState } from "@/components/states";
import { useApp } from "@/components/AppState";

type AlertItem = EventItem & { ackAt: string | null; ackBy: string | null };
type Rule = { id: number; name: string; type: string; priority: string; cameraId: number | null; cooldownSeconds: number; notifyPush: boolean; enabled: boolean };
type Cam = { id: number; name: string; location: string };

export default function AlertsPage() {
  const { setMood } = useApp();
  const [data, setData] = useState<{ counts: { total: number; unacked: number; critical: number; important: number; demo: number }; rules: Rule[]; items: AlertItem[]; canManage: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<EventItem | null>(null);
  const [cams, setCams] = useState<Cam[]>([]);
  const [filter, setFilter] = useState<"all" | "unacked" | "critical">("all");
  const [rule, setRule] = useState({ name: "", type: "alert", priority: "important", cameraId: "", cooldownSeconds: 300, notifyPush: false });
  const [pushLocal, setPushLocal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const d = await api<typeof data>("/api/alerts?days=14");
      setData(d);
      if (d?.counts.unacked) setMood("alert");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không tải được cảnh báo");
    } finally {
      setLoading(false);
    }
  }, [setMood]);

  useEffect(() => {
    load();
    api<Cam[]>("/api/cameras").then(setCams).catch(() => {});
    setPushLocal(localStorage.getItem("dai_push") === "1");
  }, [load]);

  const ack = async (ids?: number[]) => {
    await api("/api/alerts", { method: "POST", json: ids ? { ids } : { all: true } });
    load();
  };

  const toggleRule = async (r: Rule) => {
    await api("/api/alerts", { method: "PUT", json: { action: "toggle", id: r.id } });
    load();
  };
  const deleteRule = async (r: Rule) => {
    if (!confirm(`Xóa quy tắc “${r.name}”?`)) return;
    await api("/api/alerts", { method: "PUT", json: { action: "delete", id: r.id } });
    load();
  };
  const createRule = async () => {
    if (!rule.name.trim()) return;
    await api("/api/alerts", { method: "PUT", json: { action: "create", ...rule, cameraId: rule.cameraId ? Number(rule.cameraId) : null } });
    setRule({ name: "", type: "alert", priority: "important", cameraId: "", cooldownSeconds: 300, notifyPush: false });
    load();
  };

  const items = (data?.items ?? []).filter((i) => (filter === "unacked" ? !i.ackAt : filter === "critical" ? i.priority === "critical" : true));

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold">Cảnh báo</h1>
          <div className="flex rounded-xl bg-white/5 p-1 text-sm">
            {([["all", "Tất cả"], ["unacked", `Chưa xử lý (${data?.counts.unacked ?? 0})`], ["critical", "Khẩn"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setFilter(k)} className={`rounded-lg px-3 py-1 ${filter === k ? "bg-cyan-400/20 text-white" : "text-slate-400"}`}>{l}</button>
            ))}
          </div>
          <button onClick={() => ack()} disabled={!data?.canManage || !data?.counts.unacked} className="btn btn-ghost ml-auto" title={data?.canManage ? "" : "Cần quyền vận hành"}>
            <CheckCheck className="h-4 w-4" /> Đánh dấu đã đọc tất cả
          </button>
        </div>

        {!!data?.counts.demo && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <Badge color="amber">Dữ liệu mẫu</Badge>
            <span>{data.counts.demo}/{data.counts.total} cảnh báo trong danh sách là dữ liệu mẫu — không phải sự kiện camera thật. Mỗi mục mẫu được gắn nhãn “mẫu”; tắt trong Cài đặt để ẩn khỏi báo cáo.</span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          {[
            ["Tổng cảnh báo 14 ngày", data?.counts.total, "text-white"],
            ["Chưa xử lý", data?.counts.unacked, "text-amber-300"],
            ["Khẩn", data?.counts.critical, "text-rose-300"],
          ].map(([l, v, c]) => (
            <div key={String(l)} className="glass p-3">
              <div className={`text-2xl font-bold ${c}`}>{v ?? "–"}</div>
              <div className="text-xs text-[#a9bad2]">{l}</div>
            </div>
          ))}
        </div>

        <Card title="Danh sách cảnh báo" action={<span className="text-xs text-[#a9bad2]">14 ngày gần nhất</span>}>
          {loading && <LoadingState label="Đang tải cảnh báo…" />}
          {err && <ErrorState message={err} onRetry={load} />}
          {!loading && !err && items.length === 0 && <EmptyState title="Không có cảnh báo nào khớp bộ lọc" hint="Cảnh báo được tạo từ quy tắc đang bật và các sự kiện có độ ưu tiên quan trọng/khẩn." />}
          <div className="space-y-1">
            {items.map((i) => (
              <div key={i.id} className="flex items-center gap-2 rounded-xl border border-white/5 px-1 hover:bg-white/5">
                <div className="min-w-0 flex-1">
                  <EventRow e={i} onOpen={setOpen} />
                </div>
                <div className="hidden shrink-0 text-right text-[11px] text-[#a9bad2] sm:block">
                  <div>{i.camera}</div>
                  <div>{i.ackAt ? `Đã đọc · ${i.ackBy ?? ""}` : "Chưa đọc"}</div>
                </div>
                {!i.ackAt && data?.canManage && (
                  <button onClick={() => ack([i.id])} className="btn btn-ghost shrink-0 py-1 text-xs"><CheckCheck className="h-3.5 w-3.5" /> Đã đọc</button>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <aside className="space-y-4">
        <Card title={<span className="flex items-center gap-2"><BellRing className="h-4 w-4 text-cyan-300" /> Thông báo trên thiết bị này</span>}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pushLocal}
              onChange={(e) => {
                setPushLocal(e.target.checked);
                localStorage.setItem("dai_push", e.target.checked ? "1" : "0");
              }}
              className="accent-cyan-400"
            />
            Bật thông báo đẩy trên thiết bị
          </label>
          <p className="mt-2 text-[11px] text-[#a9bad2]">Thông báo đẩy thật cần cài đặt PWA và máy chủ gửi (Web Push) — hiện lưu tùy chọn cục bộ, chưa gửi ra ngoài. Cảnh báo nhạy cảm không tự gửi cho người không có quyền.</p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-amber-300" /> Quy tắc cảnh báo</span>}>
          {!data?.canManage ? (
            <NoPermissionState what="quản lý quy tắc cảnh báo" />
          ) : (
            <div className="space-y-2">
              {data?.rules.map((r) => (
                <div key={r.id} className="rounded-xl border border-white/10 p-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
                    <Badge color={r.priority === "critical" ? "rose" : "amber"}>{r.priority === "critical" ? "Khẩn" : "Quan trọng"}</Badge>
                    <button onClick={() => toggleRule(r)} className="rounded p-1 hover:bg-white/10" aria-label={r.enabled ? "Tắt quy tắc" : "Bật quy tắc"} title={r.enabled ? "Đang bật" : "Đang tắt"}>
                      {r.enabled ? <BellRing className="h-4 w-4 text-emerald-300" /> : <BellOff className="h-4 w-4 text-slate-500" />}
                    </button>
                    <button onClick={() => deleteRule(r)} className="rounded p-1 text-slate-500 hover:text-rose-300" aria-label="Xóa quy tắc"><Trash2 className="h-4 w-4" /></button>
                  </div>
                  <div className="text-[11px] text-[#a9bad2]">
                    {r.type} · {r.cameraId ? cams.find((c) => c.id === r.cameraId)?.name ?? `Camera #${r.cameraId}` : "Mọi camera"} · chống lặp {r.cooldownSeconds}s
                  </div>
                </div>
              ))}
              {!data?.rules.length && <p className="text-xs text-[#a9bad2]">Chưa có quy tắc.</p>}
              <div className="space-y-2 border-t border-white/10 pt-2">
                <input value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} placeholder="Tên quy tắc mới" className="input" />
                <div className="grid grid-cols-2 gap-2">
                  <select value={rule.cameraId} onChange={(e) => setRule({ ...rule, cameraId: e.target.value })} className="input" aria-label="Camera">
                    <option value="">Mọi camera</option>
                    {cams.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select value={rule.priority} onChange={(e) => setRule({ ...rule, priority: e.target.value })} className="input" aria-label="Mức độ">
                    <option value="important">Quan trọng</option>
                    <option value="critical">Khẩn</option>
                  </select>
                </div>
                <button onClick={createRule} className="btn btn-primary w-full text-xs"><Plus className="h-4 w-4" /> Thêm quy tắc</button>
                <p className="text-[11px] text-[#a9bad2]">Quy tắc được áp dụng phía máy chủ khi có sự kiện mới; trình duyệt không thể tự nâng mức độ cảnh báo của dữ liệu client gửi.</p>
              </div>
            </div>
          )}
        </Card>
        <div className="glass rounded-2xl p-3 text-[11px] text-[#a9bad2]">
          Cảnh báo là bằng chứng cần xem lại, không phải kết luận. Mỗi mục luôn mở được ảnh gốc; dữ liệu mẫu được ghi rõ “mẫu”.
        </div>
      </aside>

      <EventDetail e={open} onClose={() => setOpen(null)} onSaved={load} />
    </div>
  );
}
