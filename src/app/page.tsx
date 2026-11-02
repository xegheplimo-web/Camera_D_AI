"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PlayCircle, Camera, UploadCloud, NotebookPen, Search, Mic, BarChart3, FileText, Users, Car, Bike, AlertTriangle, Image as ImageIcon, Film, StickyNote, BrainCircuit, Plus, ChevronRight } from "lucide-react";
import Robot from "@/components/Robot";
import ChatPanel from "@/components/ChatPanel";
import CameraView, { type Cam } from "@/components/CameraView";
import EventDetail from "@/components/EventDetail";
import { Card, EventRow, StatTile, type EventItem } from "@/components/ui";
import { useApp } from "@/components/AppState";

type Dash = {
  today: { personIn: number; personOut: number; vehicles: number; motorcycles: number; cars: number; alerts: number; total: number };
  hourly: { h: number; people: number; vehicles: number }[];
  memory: { images: number; videos: number; notes: number; verified: number; events: number };
  cameras: (Cam & { today: number; recent5m: number })[];
  recent: EventItem[];
  activeAlert: boolean;
  storageBytes: number;
  lastSyncAt: string | null;
  unackedAlerts: number;
  demoShare: { demo: number; total: number };
  settings: { demoMode: boolean };
};

function greeting() {
  const h = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "numeric", hour12: false }));
  return h < 11 ? "Chào buổi sáng!" : h < 14 ? "Chào buổi trưa!" : h < 18 ? "Chào buổi chiều!" : "Chào buổi tối!";
}

export default function HomePage() {
  const { mood, setMood } = useApp();
  const [d, setD] = useState<Dash | null>(null);
  const [camId, setCamId] = useState<number | null>(null);
  const [open, setOpen] = useState<EventItem | null>(null);
  const [hello, setHello] = useState("Xin chào!");
  const lastTop = useRef<number | null>(null);
  const [newIds, setNewIds] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard", { cache: "no-store" });
      const j: Dash = await r.json();
      setD(j);
      setCamId((c) => c ?? j.cameras[0]?.id ?? null);
      const top = j.recent[0]?.id ?? null;
      if (lastTop.current !== null && top !== null && top !== lastTop.current) {
        setNewIds(new Set(j.recent.filter((e) => e.id > (lastTop.current ?? 0)).map((e) => e.id)));
        if (j.recent[0]?.type === "alert") setMood("alert");
      }
      lastTop.current = top;
    } catch {}
  }, [setMood]);

  useEffect(() => {
    setHello(greeting());
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const cam = d?.cameras.find((c) => c.id === camId) ?? d?.cameras[0];
  const maxH = Math.max(1, ...(d?.hourly ?? []).map((h) => Math.max(h.people, h.vehicles)));

  const actions = [
    { label: "Xem trực tiếp", icon: PlayCircle, href: "/camera", color: "text-cyan-300" },
    { label: "Chụp ảnh", icon: Camera, href: "/extract?mode=capture", color: "text-sky-300" },
    { label: "Tải ảnh lên", icon: UploadCloud, href: "/extract?mode=upload", color: "text-blue-300" },
    { label: "Ghi chú nhanh", icon: NotebookPen, href: "/extract", color: "text-amber-300" },
    { label: "Tìm bằng AI", icon: Search, href: "/memory?focus=1", color: "text-teal-300" },
    { label: "Hỏi bằng giọng nói", icon: Mic, onClick: () => window.dispatchEvent(new Event("dai:mic")), color: "text-violet-300" },
    { label: "Xem thống kê", icon: BarChart3, href: "/stats", color: "text-emerald-300" },
    { label: "Xuất báo cáo", icon: FileText, href: "/api/report?days=7", color: "text-slate-200", download: true },
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-12">
      {/* Robot hero */}
      <section className="glass relative overflow-hidden rounded-2xl p-4 xl:col-span-4">
        <div className="pointer-events-none absolute -left-10 -top-10 h-48 w-48 rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <Robot mood={mood} size={140} wave={mood === "idle"} />
          <div className="relative flex-1 rounded-2xl rounded-bl-sm border border-cyan-400/30 bg-[#0d1d40]/90 p-3 shadow-[0_0_20px_rgba(34,227,255,0.15)]">
            <div className="font-bold text-white">{hello}</div>
            <p className="text-sm text-slate-300">Mình là <b className="text-cyan-300">D-AI Bot</b>. Hôm nay đã ghi nhận <b className="text-white">{d?.today.personIn ?? "…"}</b> lượt khách{d?.today.alerts ? <> và <b className="text-orange-300">{d.today.alerts} cảnh báo</b></> : ""}. Bạn muốn mình làm gì?</p>
          </div>
        </div>
        <div className="relative mt-3 flex flex-wrap gap-2 text-[11px]">
          <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-emerald-300">● {d?.cameras.filter((c) => c.status === "online").length ?? 0}/{d?.cameras.length ?? 0} camera online</span>
          <span className="rounded-full bg-cyan-500/15 px-2 py-1 text-cyan-300">Xử lý AI trên máy chủ</span>
          <span className="rounded-full bg-violet-500/15 px-2 py-1 text-violet-300">Giọng nói: phát trên máy này</span>
        </div>
      </section>

      {/* Quick actions */}
      <section className="grid grid-cols-4 gap-2 sm:gap-3 xl:col-span-8">
        {actions.map((a) => {
          const inner = (
            <>
              <a.icon className={`h-7 w-7 ${a.color}`} />
              <span className="text-center text-[11px] font-medium leading-tight text-slate-200 sm:text-xs">{a.label}</span>
            </>
          );
          const cls = "glass group flex flex-col items-center justify-center gap-2 rounded-2xl p-3 transition hover:-translate-y-0.5 hover:border-cyan-400/50 hover:shadow-[0_0_20px_rgba(34,227,255,0.25)]";
          return a.href ? (
            a.download ? <a key={a.label} href={a.href} className={cls}>{inner}</a> : <Link key={a.label} href={a.href} className={cls}>{inner}</Link>
          ) : (
            <button key={a.label} onClick={a.onClick} className={cls}>{inner}</button>
          );
        })}
      </section>

      {(d?.demoShare.demo ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-400/30 bg-[#211d1b] px-3 py-2 text-xs text-amber-100 xl:col-span-12">
          <span className="rounded bg-amber-400/20 px-1.5 py-0.5 font-semibold">Dữ liệu mẫu</span>
          {d?.demoShare.demo.toLocaleString("vi-VN")} bản ghi mẫu đang bật để bạn trải nghiệm. {d?.settings.demoMode ? "Tắt trong Cài đặt khi dùng thật." : "Chế độ thật: dữ liệu mẫu đã bị loại khỏi truy vấn."}
          <Link href="/settings#data" className="ml-auto font-semibold text-amber-200 underline">Quản lý dữ liệu mẫu</Link>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 xl:col-span-12 md:grid-cols-4">
        {[
          ["Camera trực tuyến", `${d?.cameras.filter((c) => c.status === "online").length ?? 0}/${d?.cameras.length ?? 0}`, "text-emerald-300"],
          ["Dung lượng ảnh/clip", `${((d?.storageBytes ?? 0) / 1024 / 1024).toFixed(1)} MB`, "text-cyan-300"],
          ["Đồng bộ gần nhất", d?.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "—", "text-slate-200"],
          ["Cảnh báo chưa xử lý", String(d?.unackedAlerts ?? 0), (d?.unackedAlerts ?? 0) > 0 ? "text-amber-300" : "text-slate-200"],
        ].map(([l, v, c]) => (
          <div key={l} className="glass flex items-center justify-between px-3 py-2">
            <span className="text-[11px] text-[#a9bad2]">{l}</span>
            <span className={`text-sm font-bold ${c}`}>{v}</span>
          </div>
        ))}
      </div>

      {/* Camera main */}
      <div className="glass rounded-2xl p-3 xl:col-span-6">
        {cam ? <CameraView cam={cam} compact onEvent={load} /> : <div className="aspect-video animate-pulse rounded-xl bg-slate-800/50" />}
      </div>

      {/* Camera list */}
      <div className="glass flex flex-col gap-2 rounded-2xl p-3 xl:col-span-2">
        <div className="scroll-thin flex gap-2 overflow-x-auto xl:flex-col xl:overflow-visible">
          {d?.cameras.map((c) => (
            <button
              key={c.id}
              onClick={() => setCamId(c.id)}
              className={`flex min-w-[170px] items-center gap-2 rounded-xl border p-1.5 text-left transition xl:min-w-0 ${c.id === cam?.id ? "border-emerald-400/70 bg-emerald-500/10 shadow-[0_0_14px_rgba(52,211,153,0.3)]" : "border-white/10 hover:bg-white/5"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.thumbnail ?? ""} alt="" className="h-11 w-16 rounded-lg object-cover" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{c.name}</div>
                <div className="truncate text-[11px] text-slate-400">{c.location}</div>
                <div className="text-[10px] text-emerald-300">{c.today} sự kiện hôm nay</div>
              </div>
            </button>
          ))}
        </div>
        <Link href="/settings#cameras" className="btn btn-ghost mt-auto text-xs"><Plus className="h-4 w-4" /> Thêm camera</Link>
      </div>

      {/* Chat */}
      <div className="xl:col-span-4 xl:row-span-2">
        <ChatPanel compact />
      </div>

      {/* Stats today */}
      <Card title="Thống kê hôm nay" action={<Link href="/stats" className="flex items-center text-xs text-cyan-300">Chi tiết <ChevronRight className="h-3 w-3" /></Link>} className="xl:col-span-3">
        <div className="grid grid-cols-4 gap-2">
          <StatTile icon={<Users className="h-5 w-5 text-emerald-300" />} value={d?.today.personIn ?? "–"} label="Lượt khách" color="border-emerald-500/30 bg-emerald-500/10" />
          <StatTile icon={<Car className="h-5 w-5 text-sky-300" />} value={d?.today.cars ?? "–"} label="Ô tô" color="border-sky-500/30 bg-sky-500/10" />
          <StatTile icon={<Bike className="h-5 w-5 text-fuchsia-300" />} value={d?.today.motorcycles ?? "–"} label="Xe máy" color="border-fuchsia-500/30 bg-fuchsia-500/10" />
          <StatTile icon={<AlertTriangle className="h-5 w-5 text-orange-300" />} value={d?.today.alerts ?? "–"} label="Cảnh báo" color="border-orange-500/30 bg-orange-500/10" />
        </div>
        <div className="mt-3 flex h-28 items-end gap-1">
          {(d?.hourly ?? []).map((h) => (
            <div key={h.h} className="flex flex-1 flex-col items-center gap-1" title={`${h.h}h: ${h.people} khách, ${h.vehicles} xe`}>
              <div className="flex w-full items-end justify-center gap-[2px]" style={{ height: 88 }}>
                <div className="w-1/2 rounded-t bg-gradient-to-t from-emerald-600 to-emerald-300" style={{ height: `${(h.people / maxH) * 88}px` }} />
                <div className="w-1/2 rounded-t bg-gradient-to-t from-blue-700 to-sky-400" style={{ height: `${(h.vehicles / maxH) * 88}px` }} />
              </div>
              <span className="text-[9px] text-slate-400">{String(h.h).padStart(2, "0")}h</span>
            </div>
          ))}
          {d && d.hourly.length === 0 && <div className="w-full text-center text-sm text-slate-400">Chưa có dữ liệu hôm nay</div>}
        </div>
        <div className="mt-1 flex gap-3 text-[10px] text-slate-400"><span><i className="mr-1 inline-block h-2 w-2 rounded bg-emerald-400" />Khách</span><span><i className="mr-1 inline-block h-2 w-2 rounded bg-sky-400" />Phương tiện</span></div>
      </Card>

      {/* Recent events */}
      <Card title="Sự kiện gần đây" action={<Link href="/memory" className="flex items-center text-xs text-cyan-300">Xem tất cả <ChevronRight className="h-3 w-3" /></Link>} className="xl:col-span-3">
        <div className="scroll-thin -mx-2 max-h-72 space-y-0.5 overflow-y-auto">
          {d?.recent.map((e) => <EventRow key={e.id} e={e} onOpen={setOpen} highlight={newIds.has(e.id)} />)}
        </div>
      </Card>

      {/* Memory store */}
      <Card title="Kho trí nhớ" className="xl:col-span-2">
        <div className="space-y-2.5">
          {[
            { icon: ImageIcon, label: "Ảnh đã lưu", v: d?.memory.images, c: "text-emerald-300 bg-emerald-500/15" },
            { icon: Film, label: "Video đã lưu", v: d?.memory.videos, c: "text-fuchsia-300 bg-fuchsia-500/15" },
            { icon: StickyNote, label: "Ghi chú", v: d?.memory.notes, c: "text-amber-300 bg-amber-500/15" },
            { icon: BrainCircuit, label: "Sự kiện đã nhớ", v: d?.memory.events, c: "text-violet-300 bg-violet-500/15" },
          ].map((m) => (
            <Link key={m.label} href="/memory" className="flex items-center gap-3 rounded-xl p-1 hover:bg-white/5">
              <span className={`grid h-9 w-9 place-items-center rounded-lg ${m.c}`}><m.icon className="h-5 w-5" /></span>
              <div>
                <div className="text-[11px] text-slate-400">{m.label}</div>
                <div className="font-bold">{m.v?.toLocaleString("vi-VN") ?? "–"}</div>
              </div>
            </Link>
          ))}
        </div>
      </Card>

      <EventDetail e={open} onClose={() => setOpen(null)} onSaved={load} />
    </div>
  );
}
