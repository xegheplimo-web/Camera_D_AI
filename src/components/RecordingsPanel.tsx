"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, History, Scissors } from "lucide-react";
import { api } from "@/lib/client";
import { fmtTime } from "@/lib/time";
import { Card } from "./ui";

type Segment = { file: string; cameraKey: string; start: string; durationSec?: number; sizeBytes: number };
type EvMarker = { id: number; type: string; at: string; label: string; assetId: number | null };
type RecResponse = { segments: Segment[]; events?: EvMarker[] };

const DAY_MS = 86_400_000;
const MAX_CLIP_MS = 600_000;

function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Date → giá trị <input type="datetime-local"> (giờ địa phương, tới giây). */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function playUrl(cameraId: number, startIso: string, extra = ""): string {
  return `/api/recordings/play?cameraId=${cameraId}&start=${encodeURIComponent(startIso)}&format=mp4${extra}`;
}

/**
 * Tab "Xem lại" của trang Camera: chọn ngày, timeline 24h có vạch segment +
 * chấm sự kiện (bấm → phát từ đúng mốc), nút "Xuất clip" cắt from→to ≤ 10 phút
 * qua /api/recordings/clip. Panel tự ẩn hoàn toàn khi camera không có bản ghi.
 */
export default function RecordingsPanel({ cameraId }: { cameraId: number }) {
  const [segs, setSegs] = useState<Segment[] | null>(null);
  const [events, setEvents] = useState<EvMarker[]>([]);
  const [day, setDay] = useState(() => localDay());
  const [playing, setPlaying] = useState<{ start: string; offset: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [clipFrom, setClipFrom] = useState("");
  const [clipTo, setClipTo] = useState("");
  const [clipBusy, setClipBusy] = useState(false);
  const [clipErr, setClipErr] = useState<string | null>(null);
  const tlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    setSegs(null);
    setPlaying(null);
    setEvents([]);
    api<RecResponse>(`/api/recordings?cameraId=${cameraId}`)
      .then((r) => { if (!stop) setSegs(r.segments); })
      .catch(() => { if (!stop) setSegs([]); });
    return () => { stop = true; };
  }, [cameraId]);

  useEffect(() => {
    let stop = false;
    api<RecResponse>(`/api/recordings?cameraId=${cameraId}&day=${day}`)
      .then((r) => { if (!stop) setEvents(r.events ?? []); })
      .catch(() => { if (!stop) setEvents([]); });
    return () => { stop = true; };
  }, [cameraId, day]);

  const dayBounds = useMemo(() => {
    const [y, m, d] = day.split("-").map(Number);
    const t0 = new Date(y, m - 1, d).getTime();
    return { t0, t1: t0 + DAY_MS };
  }, [day]);

  const daySegs = useMemo(
    () => (segs ?? []).filter((s) => { const t = new Date(s.start).getTime(); return t >= dayBounds.t0 && t < dayBounds.t1; }),
    [segs, dayBounds],
  );

  if (!segs?.length) return null;

  /** Mốc ms (trong ngày) → segment chứa nó; fallback: segment gần nhất trước mốc, rồi sớm nhất. */
  const segAt = (ms: number): Segment | null => {
    let before: Segment | null = null;
    for (const s of daySegs) {
      const t = new Date(s.start).getTime();
      const end = t + (s.durationSec ?? 300) * 1000;
      if (ms >= t && ms < end) return s;
      if (t <= ms && (!before || t > new Date(before.start).getTime())) before = s;
    }
    return before ?? daySegs[0] ?? null;
  };

  const playAt = (ms: number) => {
    const seg = segAt(ms);
    if (!seg) return;
    const offset = Math.max(0, Math.round((ms - new Date(seg.start).getTime()) / 100) / 10);
    setPlaying({ start: seg.start, offset });
  };

  const openExport = () => {
    setClipErr(null);
    if (playing) {
      const seg = daySegs.find((s) => s.start === playing.start);
      const t0 = new Date(playing.start).getTime() + playing.offset * 1000;
      const t1 = seg ? new Date(seg.start).getTime() + (seg.durationSec ?? 300) * 1000 : t0 + MAX_CLIP_MS;
      setClipFrom(toLocalInput(new Date(t0)));
      setClipTo(toLocalInput(new Date(Math.min(t1, t0 + MAX_CLIP_MS))));
    } else {
      const now = new Date();
      setClipFrom(toLocalInput(new Date(now.getTime() - MAX_CLIP_MS)));
      setClipTo(toLocalInput(now));
    }
    setExportOpen(true);
  };

  const fromMs = Date.parse(clipFrom);
  const toMs = Date.parse(clipTo);
  const clipValid = Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs && toMs - fromMs <= MAX_CLIP_MS;
  const clipSec = clipValid ? Math.round((toMs - fromMs) / 1000) : 0;

  const downloadClip = async () => {
    setClipBusy(true);
    setClipErr(null);
    try {
      const url = `/api/recordings/clip?cameraId=${cameraId}&from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}&download=1`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        let message = `Lỗi ${res.status}`;
        try { const p = await res.json(); message = [p.title, p.detail].filter(Boolean).join(": ") || message; } catch { /* giữ message chung */ }
        throw new Error(message);
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `clip-${cameraId}-${toLocalInput(new Date(fromMs)).replace(/[:T]/g, "-")}.mp4`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setClipErr(`Không xuất được clip: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setClipBusy(false);
    }
  };

  const days = [...new Set(segs.map((s) => localDay(new Date(s.start))))].sort((a, b) => b.localeCompare(a));
  const clipHref = playing ? playUrl(cameraId, playing.start, "&download=1") : null;

  return (
    <Card title={<span className="flex items-center gap-2"><History className="h-4 w-4 text-cyan-300" /> Xem lại</span>}
      action={<input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="input w-auto py-1 text-xs" aria-label="Chọn ngày" />}>
      <div className="space-y-2">
        {playing && (
          <video key={`${playing.start}#${playing.offset}`} src={`${playUrl(cameraId, playing.start)}#t=${playing.offset}`} controls autoPlay className="aspect-video w-full rounded-xl bg-black" />
        )}
        <div ref={tlRef} className="relative h-10 w-full rounded-lg bg-slate-800/70" role="group" aria-label="Thời gian có bản ghi">
          {[0, 6, 12, 18].map((h) => (
            <span key={h} className="absolute -bottom-0.5 text-[9px] text-slate-500" style={{ left: `${(h / 24) * 100}%` }}>{h}h</span>
          ))}
          {daySegs.map((s) => {
            const t = new Date(s.start).getTime();
            const left = ((t - dayBounds.t0) / DAY_MS) * 100;
            const width = Math.max(((s.durationSec ?? 300) * 1000 / DAY_MS) * 100, 0.8);
            const active = playing?.start === s.start;
            return (
              <button key={s.file} onClick={(e) => {
                // Vị trí bấm trên thanh thời gian → mốc trong ngày → offset giây
                // trong segment; #t= cho browser seek đúng mốc (server phát cả file).
                const rect = tlRef.current?.getBoundingClientRect();
                const frac = rect && rect.width > 0 ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
                const offset = Math.max(0, Math.round((dayBounds.t0 + frac * DAY_MS - t) / 100) / 10);
                setPlaying({ start: s.start, offset });
              }}
                title={`${fmtTime(s.start)} · ${(s.sizeBytes / 1048576).toFixed(1)} MB`}
                aria-label={`Phát từ ${fmtTime(s.start)}`}
                className={`absolute top-1.5 h-6 rounded-sm ${active ? "bg-cyan-300" : "bg-cyan-500/60 hover:bg-cyan-400"}`}
                style={{ left: `${Math.min(99, Math.max(0, left))}%`, width: `${Math.min(width, 100 - Math.max(0, left))}%` }} />
            );
          })}
          {events.map((ev) => {
            const ms = new Date(ev.at).getTime();
            if (ms < dayBounds.t0 || ms >= dayBounds.t1) return null;
            return (
              <button key={ev.id} onClick={() => playAt(ms)}
                title={`${fmtTime(ev.at)} · ${ev.label}`}
                aria-label={`Sự kiện ${fmtTime(ev.at)}: ${ev.label}`}
                className="absolute top-1/2 z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-400 ring-1 ring-red-200/50 hover:bg-red-300"
                style={{ left: `${Math.min(100, Math.max(0, ((ms - dayBounds.t0) / DAY_MS) * 100))}%` }} />
            );
          })}
          {!daySegs.length && <p className="absolute inset-0 grid place-items-center text-[11px] text-slate-400">Không có bản ghi trong ngày này.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span>{daySegs.length} đoạn trong ngày · {segs.length} đoạn tổng cộng{events.length ? ` · ${events.length} sự kiện` : ""}</span>
          {days.length > 1 && (
            <span className="flex gap-1">
              {days.slice(0, 7).map((d) => (
                <button key={d} onClick={() => setDay(d)} className={`rounded px-1.5 py-0.5 ${d === day ? "bg-cyan-500/30 text-cyan-200" : "bg-white/5 hover:bg-white/10"}`}>{d.slice(8, 10)}/{d.slice(5, 7)}</button>
              ))}
            </span>
          )}
          <span className="ml-auto flex gap-1">
            <button onClick={() => (exportOpen ? setExportOpen(false) : openExport())} className="btn btn-ghost py-1 text-xs" aria-label="Xuất clip">
              <Scissors className="h-3.5 w-3.5" /> Xuất clip
            </button>
            {clipHref && (
              <a href={clipHref} download className="btn btn-ghost py-1 text-xs"><Download className="h-3.5 w-3.5" /> Tải đoạn này</a>
            )}
          </span>
        </div>
        {exportOpen && (
          <div className="space-y-1.5 rounded-lg bg-slate-800/60 p-2 text-[11px] text-slate-300" role="group" aria-label="Xuất clip theo khoảng">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1">
                Từ
                <input type="datetime-local" step={1} value={clipFrom} onChange={(e) => setClipFrom(e.target.value)} className="input w-auto py-0.5 text-xs" aria-label="Từ lúc" />
              </label>
              <label className="flex items-center gap-1">
                Đến
                <input type="datetime-local" step={1} value={clipTo} onChange={(e) => setClipTo(e.target.value)} className="input w-auto py-0.5 text-xs" aria-label="Đến lúc" />
              </label>
              <span className="text-slate-400">
                {clipValid ? `≈ ${Math.floor(clipSec / 60)}:${String(clipSec % 60).padStart(2, "0")} phút` : "Khoảng không hợp lệ (tối đa 10 phút)"}
              </span>
              <button onClick={downloadClip} disabled={!clipValid || clipBusy} className="btn btn-primary ml-auto py-1 text-xs disabled:opacity-40">
                {clipBusy ? "Đang xuất…" : "Tải clip"}
              </button>
            </div>
            {clipErr && <p className="text-red-300" role="alert">{clipErr}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}
