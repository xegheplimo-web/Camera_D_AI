"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Users, LogOut, Car, AlertTriangle, Activity, Download, Database } from "lucide-react";
import { Card, StatTile } from "@/components/ui";
import { api } from "@/lib/client";
import { EVENT_TYPES } from "@/lib/labels";

type Stats = {
  meta?: { timezone: string; demoShare: number; total: number; hoursCovered: number };
  totals: { personIn: number; personOut: number; vehicles: number; alerts: number; total: number };
  daily: { day: string; personIn: number; personOut: number; vehicles: number }[];
  heat: { dow: number; h: number; c: number }[];
  byCamera: { cameraId: number; name: string; c: number }[];
  byType: { type: string; c: number }[];
};

const DOW = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];

export default function StatsPage() {
  const [days, setDays] = useState(7);
  const [s, setS] = useState<Stats | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    setS(null);
    api<Stats>(`/api/stats?days=${days}`).then(setS).catch(() => {});
  }, [days]);

  const maxD = Math.max(1, ...(s?.daily ?? []).map((d) => Math.max(d.personIn, d.personOut, d.vehicles)));
  const maxHeat = Math.max(1, ...(s?.heat ?? []).map((h) => h.c));
  const maxCam = Math.max(1, ...(s?.byCamera ?? []).map((c) => c.c));
  const maxType = Math.max(1, ...(s?.byType ?? []).map((c) => c.c));
  const SourceBtn = ({ k }: { k: string }) => (
    <button onClick={() => setSrc(src === k ? null : k)} className="flex items-center gap-1 text-xs text-cyan-300 hover:underline"><Database className="h-3 w-3" /> {src === k ? "Ẩn dữ liệu nguồn" : "Xem dữ liệu nguồn"}</button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">Thống kê</h1>
        <div className="flex rounded-xl bg-white/5 p-1 text-sm">
          {[[1, "Hôm nay"], [7, "7 ngày"], [30, "30 ngày"]].map(([d, l]) => (
            <button key={d} onClick={() => setDays(d as number)} className={`rounded-lg px-3 py-1 ${days === d ? "bg-cyan-500/25 text-white" : "text-slate-400"}`}>{l}</button>
          ))}
        </div>
        <a href={`/api/report?days=${days}`} className="btn btn-ghost ml-auto"><Download className="h-4 w-4" /> Xuất CSV</a>
      </div>

      <div className="glass space-y-1 p-3 text-xs text-[#a9bad2]">
        <div className="font-semibold text-white">Truy vết nguồn số liệu</div>
        <div>• Định nghĩa: <b className="text-slate-200">lượt vào</b> = COUNT(events) với type=person_in; <b className="text-slate-200">lượt ra</b> = type=person_out; <b className="text-slate-200">phương tiện</b> = type=vehicle. Đây là số lượt qua vạch, không phải số người duy nhất.</div>
        <div>• Phạm vi: {days} ngày gần nhất · múi giờ Asia/Ho_Chi_Minh · khoảng nửa mở [start, end).</div>
        <div>• Dữ liệu dùng: {s?.totals.total ?? "–"} bản ghi, trong đó <b className={s?.meta?.demoShare ? "text-amber-300" : "text-emerald-300"}>{Math.round((s?.meta?.demoShare ?? 0) * 100)}%</b> là dữ liệu mẫu. Bản ghi do trình duyệt nhận diện được đánh dấu “client báo” và có thể chưa chính xác.</div>
        <div>• Thiếu dữ liệu: các ngày/giờ không có camera hoạt động hiển thị bằng 0 nhưng không đồng nghĩa “không có người”.</div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile icon={<Users className="h-6 w-6 text-emerald-300" />} value={s?.totals.personIn ?? "–"} label="Lượt vào" color="border-emerald-500/30 bg-emerald-500/10" />
        <StatTile icon={<LogOut className="h-6 w-6 text-sky-300" />} value={s?.totals.personOut ?? "–"} label="Lượt ra" color="border-sky-500/30 bg-sky-500/10" />
        <StatTile icon={<Car className="h-6 w-6 text-fuchsia-300" />} value={s?.totals.vehicles ?? "–"} label="Phương tiện" color="border-fuchsia-500/30 bg-fuchsia-500/10" />
        <StatTile icon={<AlertTriangle className="h-6 w-6 text-orange-300" />} value={s?.totals.alerts ?? "–"} label="Cảnh báo" color="border-orange-500/30 bg-orange-500/10" />
        <StatTile icon={<Activity className="h-6 w-6 text-violet-300" />} value={s?.totals.total ?? "–"} label="Tổng sự kiện" color="border-violet-500/30 bg-violet-500/10" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Vào / Ra & phương tiện theo ngày" action={<SourceBtn k="daily" />}>
          <div className="flex h-48 items-end gap-1">
            {s?.daily.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day}: vào ${d.personIn}, ra ${d.personOut}, xe ${d.vehicles}`}>
                <div className="flex h-40 w-full items-end justify-center gap-[2px]">
                  <div className="w-1/3 rounded-t bg-emerald-400" style={{ height: `${(d.personIn / maxD) * 100}%` }} />
                  <div className="w-1/3 rounded-t bg-sky-400" style={{ height: `${(d.personOut / maxD) * 100}%` }} />
                  <div className="w-1/3 rounded-t bg-fuchsia-400" style={{ height: `${(d.vehicles / maxD) * 100}%` }} />
                </div>
                <span className="text-[9px] text-slate-400">{d.day.slice(8)}/{d.day.slice(5, 7)}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-3 text-[11px] text-slate-400"><span><i className="mr-1 inline-block h-2 w-2 rounded bg-emerald-400" />Vào</span><span><i className="mr-1 inline-block h-2 w-2 rounded bg-sky-400" />Ra</span><span><i className="mr-1 inline-block h-2 w-2 rounded bg-fuchsia-400" />Phương tiện</span></div>
          {src === "daily" && (
            <table className="mt-3 w-full text-xs">
              <thead className="text-slate-400"><tr><th className="text-left">Ngày</th><th>Vào</th><th>Ra</th><th>Xe</th><th></th></tr></thead>
              <tbody>{s?.daily.map((d) => (
                <tr key={d.day} className="border-t border-white/5 text-center"><td className="text-left">{d.day}</td><td>{d.personIn}</td><td>{d.personOut}</td><td>{d.vehicles}</td>
                  <td><Link className="text-cyan-300" href={`/memory?from=${new Date(`${d.day}T00:00:00+07:00`).toISOString()}&to=${new Date(new Date(`${d.day}T00:00:00+07:00`).getTime() + 86400000).toISOString()}`}>Xem</Link></td></tr>
              ))}</tbody>
            </table>
          )}
        </Card>

        <Card title="Bản đồ nhiệt lượt khách (thứ × giờ)" action={<SourceBtn k="heat" />}>
          <div className="overflow-x-auto">
            <div className="grid min-w-[520px] gap-[3px]" style={{ gridTemplateColumns: "28px repeat(24, 1fr)" }}>
              <div />
              {Array.from({ length: 24 }, (_, h) => <div key={h} className="text-center text-[8px] text-slate-500">{h % 3 === 0 ? h : ""}</div>)}
              {DOW.map((d, i) => (
                <div key={d} className="contents">
                  <div className="text-[10px] leading-5 text-slate-400">{d}</div>
                  {Array.from({ length: 24 }, (_, h) => {
                    const c = s?.heat.find((x) => x.dow === i + 1 && x.h === h)?.c ?? 0;
                    return <div key={h} title={`${d} ${h}h: ${c}`} className="h-5 rounded-sm" style={{ background: c ? `rgba(34,227,255,${0.12 + (c / maxHeat) * 0.88})` : "rgba(255,255,255,0.04)" }} />;
                  })}
                </div>
              ))}
            </div>
          </div>
          {src === "heat" && <p className="mt-2 text-xs text-slate-400">Nguồn: COUNT(events) với type = person_in, nhóm theo thứ (ISO) và giờ, múi giờ Asia/Ho_Chi_Minh, {days} ngày gần nhất. Tổng ô: {s?.heat.reduce((a, b) => a + b.c, 0)}.</p>}
        </Card>

        <Card title="Camera hoạt động nhiều nhất" action={<SourceBtn k="cam" />}>
          <div className="space-y-2">
            {s?.byCamera.map((c) => (
              <div key={c.cameraId}>
                <div className="flex justify-between text-sm"><span>{c.name}</span><b>{c.c}</b></div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-blue-500" style={{ width: `${(c.c / maxCam) * 100}%` }} /></div>
              </div>
            ))}
          </div>
          {src === "cam" && <div className="mt-2 flex flex-wrap gap-2">{s?.byCamera.map((c) => <Link key={c.cameraId} href={`/memory?camera=${c.cameraId}`} className="text-xs text-cyan-300">{c.name} →</Link>)}</div>}
        </Card>

        <Card title="Loại sự kiện" action={<SourceBtn k="type" />}>
          <div className="space-y-2">
            {s?.byType.map((t) => (
              <div key={t.type} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0 text-slate-300">{EVENT_TYPES[t.type]?.label ?? t.type}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400" style={{ width: `${(t.c / maxType) * 100}%` }} /></div>
                <b className="w-12 text-right">{t.c}</b>
              </div>
            ))}
          </div>
          {src === "type" && <div className="mt-2 flex flex-wrap gap-2">{s?.byType.map((t) => <Link key={t.type} href={`/memory?type=${t.type}`} className="text-xs text-cyan-300">{EVENT_TYPES[t.type]?.label ?? t.type} →</Link>)}</div>}
        </Card>
      </div>
    </div>
  );
}
