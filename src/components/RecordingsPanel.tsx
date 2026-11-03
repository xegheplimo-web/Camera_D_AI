"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, History } from "lucide-react";
import { api } from "@/lib/client";
import { fmtTime } from "@/lib/time";
import { Card } from "./ui";

type Segment = { file: string; cameraKey: string; start: string; durationSec?: number; sizeBytes: number };
type RecResponse = { segments: Segment[] };

const DAY_MS = 86_400_000;

function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function playUrl(cameraId: number, startIso: string, extra = ""): string {
  return `/api/recordings/play?cameraId=${cameraId}&start=${encodeURIComponent(startIso)}&format=mp4${extra}`;
}

/**
 * Tab "Xem lại" của trang Camera: chọn ngày, thanh thời gian theo segment,
 * bấm mốc để phát, tải clip 60s quanh mốc. Panel tự ẩn hoàn toàn khi camera
 * không có bản ghi nào trên đĩa (kiểm tra thật qua API, không disable vô lý).
 */
export default function RecordingsPanel({ cameraId }: { cameraId: number }) {
  const [segs, setSegs] = useState<Segment[] | null>(null);
  const [day, setDay] = useState(() => localDay());
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    setSegs(null);
    setPlaying(null);
    api<RecResponse>(`/api/recordings?cameraId=${cameraId}`)
      .then((r) => { if (!stop) setSegs(r.segments); })
      .catch(() => { if (!stop) setSegs([]); });
    return () => { stop = true; };
  }, [cameraId]);

  const dayBounds = useMemo(() => {
    const [y, m, d] = day.split("-").map(Number);
    const t0 = new Date(y, m - 1, d).getTime();
    return { t0, t1: t0 + DAY_MS };
  }, [day]);

  const daySegs = useMemo(
    () => (segs ?? []).filter((s) => { const t = new Date(s.start).getTime(); return t >= dayBounds.t0 && t < dayBounds.t1; }),
    [segs, dayBounds],
  );

  // Không có bản ghi nào (đang tải hoặc rỗng) → ẩn hẳn, đúng spec "không hiện nút khi không có segment".
  if (!segs?.length) return null;

  const days = [...new Set(segs.map((s) => localDay(new Date(s.start))))].sort().reverse();
  const clipHref = playing
    ? playUrl(cameraId, new Date(Math.max(0, new Date(playing).getTime() - 30_000)).toISOString(), "&duration=60&download=1")
    : null;

  return (
    <Card title={<span className="flex items-center gap-2"><History className="h-4 w-4 text-cyan-300" /> Xem lại</span>}
      action={<input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="input w-auto py-1 text-xs" aria-label="Chọn ngày" />}>
      <div className="space-y-2">
        {playing && (
          <video key={playing} src={playUrl(cameraId, playing)} controls autoPlay className="aspect-video w-full rounded-xl bg-black" />
        )}
        <div className="relative h-10 w-full rounded-lg bg-slate-800/70" role="group" aria-label="Thời gian có bản ghi">
          {[0, 6, 12, 18].map((h) => (
            <span key={h} className="absolute -bottom-0.5 text-[9px] text-slate-500" style={{ left: `${(h / 24) * 100}%` }}>{h}h</span>
          ))}
          {daySegs.map((s) => {
            const t = new Date(s.start).getTime();
            const left = ((t - dayBounds.t0) / DAY_MS) * 100;
            const width = Math.max(((s.durationSec ?? 300) * 1000 / DAY_MS) * 100, 0.8);
            const active = playing === s.start;
            return (
              <button key={s.file} onClick={() => setPlaying(s.start)}
                title={`${fmtTime(s.start)} · ${(s.sizeBytes / 1048576).toFixed(1)} MB`}
                aria-label={`Phát từ ${fmtTime(s.start)}`}
                className={`absolute top-1.5 h-6 rounded-sm ${active ? "bg-cyan-300" : "bg-cyan-500/60 hover:bg-cyan-400"}`}
                style={{ left: `${Math.min(99, Math.max(0, left))}%`, width: `${Math.min(width, 100 - Math.max(0, left))}%` }} />
            );
          })}
          {!daySegs.length && <p className="absolute inset-0 grid place-items-center text-[11px] text-slate-400">Không có bản ghi trong ngày này.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span>{daySegs.length} đoạn trong ngày · {segs.length} đoạn tổng cộng</span>
          {days.length > 1 && (
            <span className="flex gap-1">
              {days.slice(0, 7).map((d) => (
                <button key={d} onClick={() => setDay(d)} className={`rounded px-1.5 py-0.5 ${d === day ? "bg-cyan-500/30 text-cyan-200" : "bg-white/5 hover:bg-white/10"}`}>{d.slice(8, 10)}/{d.slice(5, 7)}</button>
              ))}
            </span>
          )}
          {clipHref && (
            <a href={clipHref} download className="btn btn-ghost ml-auto py-1 text-xs"><Download className="h-3.5 w-3.5" /> Tải clip 60s quanh mốc</a>
          )}
        </div>
      </div>
    </Card>
  );
}
