"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Sparkles, Search, Filter, Loader2, X, CalendarDays, StickyNote, ListTree } from "lucide-react";
import { api } from "@/lib/client";
import { waitForJob } from "@/lib/ai/client";
import type { JobView } from "@/lib/ai/types";
import JobProgress from "@/components/JobProgress";
import { Badge, EventRow, type EventItem } from "@/components/ui";
import EventDetail from "@/components/EventDetail";
import type { AnswerPayload, ExtractionResult } from "@/db/schema";
import { EVENT_TYPES } from "@/lib/labels";

type Cam = { id: number; name: string; location: string };
type ExRow = { id: number; title: string; note: string; status: string; memoryType: string; tags: string[]; result: ExtractionResult | null; createdAt: string; thumb: string | null; assetId: number };

const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(0, 10) : "");

export default function MemoryClient() {
  const sp = useSearchParams();
  const [tab, setTab] = useState<"events" | "notes">(sp.get("tab") === "notes" ? "notes" : "events");
  const [cams, setCams] = useState<Cam[]>([]);
  const [f, setF] = useState({
    type: sp.get("type") ?? "",
    camera: sp.get("camera") ?? "",
    from: toLocalInput(sp.get("from")),
    to: toLocalInput(sp.get("to") ? new Date(new Date(sp.get("to")!).getTime() - 1).toISOString() : null),
    q: sp.get("q") ?? "",
    source: sp.get("source") ?? "",
    trust: sp.get("trust") ?? "",
    ack: sp.get("ack") ?? "",
    tag: "",
    priority: "",
    cls: "",
  });
  const [items, setItems] = useState<EventItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<EventItem | null>(null);
  const [smart, setSmart] = useState("");
  const [smartBusy, setSmartBusy] = useState(false);
  const [smartAns, setSmartAns] = useState<AnswerPayload | null>(null);
  const [smartJob, setSmartJob] = useState<JobView | null>(null);
  const [smartError, setSmartError] = useState<string | null>(null);
  const smartAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { smartAbort.current?.abort(); }, []);
  const [notes, setNotes] = useState<ExRow[]>([]);
  const [noteQ, setNoteQ] = useState("");
  const smartRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Cam[]>("/api/cameras").then(setCams).catch(() => {});
    if (sp.get("focus")) smartRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const query = useCallback(
    (before?: number) => {
      const p = new URLSearchParams();
      if (f.type) p.set("type", f.type);
      if (f.camera) p.set("camera", f.camera);
      if (f.from) p.set("from", new Date(`${f.from}T00:00:00+07:00`).toISOString());
      if (f.to) p.set("to", new Date(new Date(`${f.to}T00:00:00+07:00`).getTime() + 86400000).toISOString());
      if (f.q) p.set("q", f.q);
      if (f.tag) p.set("tag", f.tag);
      if (f.priority) p.set("priority", f.priority);
      if (f.cls) p.set("class", f.cls);
      if (f.source) p.set("source", f.source);
      if (f.trust) p.set("trust", f.trust);
      if (f.ack) p.set("ack", f.ack);
      if (before) p.set("before", String(before));
      p.set("limit", "50");
      return `/api/events?${p}`;
    },
    [f]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: EventItem[]; total: number }>(query());
      setItems(r.items);
      setTotal(r.total);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (tab !== "notes") return;
    const t = setTimeout(() => api<ExRow[]>(`/api/extractions${noteQ ? `?q=${encodeURIComponent(noteQ)}` : ""}`).then(setNotes).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [tab, noteQ]);

  const more = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    const r = await api<{ items: EventItem[] }>(query(last.id));
    setItems((x) => [...x, ...r.items]);
  };

  const runSmart = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!smart.trim() || smartBusy) return;
    smartAbort.current?.abort();
    const controller = new AbortController(); smartAbort.current = controller;
    setSmartBusy(true); setSmartError(null); setSmartAns(null); setSmartJob(null);
    try {
      const question = /^tìm|bao nhiêu|khi nào|mấy giờ|phân tích|lập báo cáo/i.test(smart.trim()) ? smart : `tìm ${smart}`;
      const response = await api<{ assistant?: { answer: AnswerPayload }; job?: JobView }>("/api/chat", { method: "POST", signal: controller.signal, json: { question, requestId: crypto.randomUUID() } });
      if (response.job) {
        const result = await waitForJob<unknown, { answer: AnswerPayload }>(response.job.id, setSmartJob, controller.signal);
        if (result.assistant) setSmartAns(result.assistant.answer);
        else setSmartError(result.job.error ?? "Chưa có kết quả. Hãy thử lại sau.");
      } else if (response.assistant) setSmartAns(response.assistant.answer);
    } catch (e) {
      if (!controller.signal.aborted) setSmartError(e instanceof Error ? e.message : "Không gửi được yêu cầu tìm kiếm");
    } finally { if (!controller.signal.aborted) setSmartBusy(false); }
  };

  // group by VN day
  const groups: { day: string; items: EventItem[] }[] = [];
  for (const e of items) {
    const day = new Date(e.happenedAt).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(e);
    else groups.push({ day, items: [e] });
  }
  const activeFilters = Object.entries(f).filter(([, v]) => v).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Trí nhớ</h1>
        <div className="flex rounded-xl bg-white/5 p-1 text-sm">
          <button onClick={() => setTab("events")} className={`flex items-center gap-1 rounded-lg px-3 py-1 ${tab === "events" ? "bg-cyan-500/25 text-white" : "text-slate-400"}`}><ListTree className="h-4 w-4" /> Dòng thời gian</button>
          <button onClick={() => setTab("notes")} className={`flex items-center gap-1 rounded-lg px-3 py-1 ${tab === "notes" ? "bg-cyan-500/25 text-white" : "text-slate-400"}`}><StickyNote className="h-4 w-4" /> Ghi chú trích xuất</button>
        </div>
      </div>

      <form onSubmit={runSmart} className="glass-strong flex items-center gap-2 rounded-2xl p-2">
        <Sparkles className="ml-2 h-5 w-5 text-cyan-300" />
        <input ref={smartRef} value={smart} onChange={(e) => setSmart(e.target.value)} placeholder="Tìm bằng AI: “xe máy hôm qua”, “cảnh báo trong kho tuần này”, “khách đầu tiên hôm nay”…" className="flex-1 bg-transparent px-2 py-2 text-sm outline-none placeholder:text-slate-500" aria-label="Tìm kiếm thông minh" />
        <button disabled={smartBusy || !smart.trim()} className="btn btn-primary">{smartBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Tìm</button>
      </form>

      {smartJob && <JobProgress job={smartJob} compact controllable={false} />}
      {smartError && <div className="rounded-xl border border-rose-400/30 bg-rose-400/5 p-3 text-sm text-rose-200" role="alert">{smartError}</div>}
      {smartAns && (
        <div className="glass anim-fadeup relative rounded-2xl p-4">
          <button onClick={() => setSmartAns(null)} className="absolute right-3 top-3 text-slate-400 hover:text-white" aria-label="Đóng"><X className="h-4 w-4" /></button>
          <div className="mb-1 flex items-center gap-2 text-xs text-cyan-300"><Sparkles className="h-3.5 w-3.5" /> D-AI Bot</div>
          <p className="font-semibold">{smartAns.short}</p>
          {smartAns.execution?.path === "fallback" && <Badge color="amber">Dịch vụ AI dự phòng · chỉ tổng hợp dữ liệu đã lưu</Badge>}
          {smartAns.warnings.some((w) => /demo|dữ liệu mẫu/i.test(w)) && <div className="mt-1 text-xs text-amber-200">{smartAns.warnings.find((w) => /demo|dữ liệu mẫu/i.test(w))}</div>}
          {smartAns.details.length > 0 && <ul className="mt-1 text-sm text-slate-300">{smartAns.details.slice(0, 5).map((d, i) => <li key={i}>• {d}</li>)}</ul>}
          {smartAns.evidence.length > 0 && (
            <div className="mt-2 flex gap-2 overflow-x-auto">
              {smartAns.evidence.map((e, i) => (
                <div key={i} className="w-32 shrink-0 overflow-hidden rounded-lg border border-white/10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {e.thumb && <img src={e.thumb} alt="" className="aspect-video w-full object-cover" />}
                  <div className="truncate px-1 py-0.5 text-[10px]">{e.time} · {e.label}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2">{smartAns.nextActions.map((n) => <Link key={n.href} href={n.href} className="text-xs text-cyan-300 hover:underline">{n.label} →</Link>)}</div>
        </div>
      )}

      {tab === "events" ? (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <aside className="glass h-fit space-y-3 rounded-2xl p-4 lg:sticky lg:top-20">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 font-semibold"><Filter className="h-4 w-4 text-cyan-300" /> Bộ lọc</span>
              {activeFilters > 0 && <button onClick={() => setF({ type: "", camera: "", from: "", to: "", q: "", tag: "", priority: "", cls: "", source: "", trust: "", ack: "" })} className="text-xs text-slate-400 hover:text-white">Xóa lọc ({activeFilters})</button>}
            </div>
            <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Từ khóa (nhãn, ghi chú, thẻ)…" className="input" aria-label="Từ khóa" />
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-slate-400">Từ ngày<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} className="input mt-1 px-2" /></label>
              <label className="text-xs text-slate-400">Đến ngày<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="input mt-1 px-2" /></label>
            </div>
            <select value={f.camera} onChange={(e) => setF({ ...f, camera: e.target.value })} className="input" aria-label="Camera">
              <option value="">Tất cả camera</option>
              {cams.map((c) => <option key={c.id} value={c.id}>{c.name} – {c.location}</option>)}
            </select>
            <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} className="input" aria-label="Loại sự kiện">
              <option value="">Mọi loại sự kiện</option>
              {Object.entries(EVENT_TYPES).filter(([k]) => k !== "extraction").map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select value={f.cls} onChange={(e) => setF({ ...f, cls: e.target.value })} className="input" aria-label="Đối tượng">
              <option value="">Mọi đối tượng</option>
              <option value="person">Người</option>
              <option value="car">Ô tô</option>
              <option value="motorcycle">Xe máy</option>
            </select>
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} className="input" aria-label="Độ ưu tiên">
              <option value="">Mọi độ ưu tiên</option>
              <option value="important">Quan trọng</option>
              <option value="critical">Khẩn</option>
            </select>
            <input value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} placeholder="Thẻ chính xác (vd: kho)" className="input" aria-label="Thẻ" />
            <select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} className="input" aria-label="Nguồn dữ liệu">
              <option value="">Mọi nguồn dữ liệu</option>
              <option value="live">Dữ liệu thật (live)</option>
              <option value="manual">Thủ công / người dùng</option>
              <option value="demo">Dữ liệu mẫu</option>
            </select>
            <select value={f.trust} onChange={(e) => setF({ ...f, trust: e.target.value })} className="input" aria-label="Mức xác minh">
              <option value="">Mọi mức xác minh</option>
              <option value="verified">Đã có nguồn máy chủ</option>
              <option value="client">Client báo · chưa xác minh</option>
            </select>
            <select value={f.ack} onChange={(e) => setF({ ...f, ack: e.target.value })} className="input" aria-label="Đã đọc cảnh báo">
              <option value="">Mọi trạng thái đọc</option>
              <option value="unacked">Chưa đọc</option>
              <option value="acked">Đã đọc</option>
            </select>
            <a href="/api/report?days=7" className="btn btn-ghost w-full text-xs">Xuất CSV 7 ngày</a>
          </aside>

          <section className="glass rounded-2xl p-4">
            <div className="mb-2 flex items-center justify-between text-sm text-slate-400">
              <span>{loading ? "Đang tải…" : `${total.toLocaleString("vi-VN")} sự kiện`}</span>
            </div>
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.day}>
                  <div className="sticky top-14 z-10 mb-1 flex items-center gap-2 bg-[#0a1630]/90 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-300 backdrop-blur">
                    <CalendarDays className="h-3.5 w-3.5" /> {g.day} <span className="font-normal text-slate-500">· {g.items.length}</span>
                  </div>
                  <div className="relative ml-2 space-y-0.5 border-l border-cyan-400/20 pl-3">
                    {g.items.map((e) => (
                      <div key={e.id} className="relative">
                        <span className="absolute -left-[17px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-cyan-400" />
                        <EventRow e={e} onOpen={setOpen} />
                        <div className="-mt-1 mb-1 ml-[76px] flex flex-wrap gap-1 text-[10px] text-slate-500">
                          {e.camera} {e.tags.map((t) => <Badge key={t}>#{t}</Badge>)} {e.source === "demo" && <Badge>mẫu</Badge>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {!loading && !items.length && <p className="py-10 text-center text-slate-400">Không có sự kiện nào khớp bộ lọc.</p>}
              {items.length < total && <button onClick={more} className="btn btn-ghost w-full">Tải thêm</button>}
            </div>
          </section>
        </div>
      ) : (
        <section className="glass space-y-3 rounded-2xl p-4">
          <input value={noteQ} onChange={(e) => setNoteQ(e.target.value)} placeholder="Tìm trong ghi chú & kết quả trích xuất…" className="input" />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {notes.map((n) => (
              <Link key={n.id} href={`/extract?asset=${n.assetId}`} className="flex gap-3 rounded-xl border border-white/10 p-3 hover:border-cyan-400/40">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {n.thumb && <img src={n.thumb} alt="" className="h-20 w-28 shrink-0 rounded-lg object-cover" />}
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{n.title}</span>
                    <Badge color={n.status === "VERIFIED" ? "emerald" : n.status === "FAILED" ? "orange" : "amber"}>{n.status === "VERIFIED" ? "Đã xác minh" : n.status === "FAILED" ? "Sai" : "Tạm"}</Badge>
                  </div>
                  <p className="line-clamp-1 text-xs text-slate-400">Yêu cầu: {n.note}</p>
                  <p className="line-clamp-2 text-xs text-slate-300">{n.result?.summary}</p>
                  <div className="flex flex-wrap gap-1">{n.tags.map((t) => <Badge key={t}>#{t}</Badge>)}<span className="text-[10px] text-slate-500">{new Date(n.createdAt).toLocaleString("vi-VN")}</span></div>
                </div>
              </Link>
            ))}
            {!notes.length && <p className="text-sm text-slate-400">Chưa có ghi chú trích xuất.</p>}
          </div>
        </section>
      )}
      <EventDetail e={open} onClose={() => setOpen(null)} onSaved={load} />
    </div>
  );
}
