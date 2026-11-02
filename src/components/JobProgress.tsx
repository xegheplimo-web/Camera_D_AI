"use client";

import Link from "next/link";
import { useState } from "react";
import { CheckCircle2, Circle, Loader2, AlertTriangle, XCircle, RotateCcw, X, ExternalLink } from "lucide-react";
import { api } from "@/lib/client";
import { useApp } from "./AppState";
import type { JobState, JobView } from "@/lib/ai/types";

export const JOB_LABELS: Record<JobState, string> = { queued: "Đang chờ", running: "Đang xử lý", succeeded: "Hoàn tất", partial: "Kết quả giới hạn", failed: "Không hoàn tất", cancelled: "Đã hủy" };
export const ROUTE_LABELS = { hermes: "Trợ lý AI", worker: "Xử lý AI trực tiếp", fallback: "Dịch vụ AI dự phòng" };

export default function JobProgress({ job, compact = false, onUpdate, controllable = true }: { job: JobView; compact?: boolean; onUpdate?: (j: JobView) => void; controllable?: boolean }) {
  const { role } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = ["queued", "running"].includes(job.state);
  const change = async (action: "retry" | "cancel") => {
    setBusy(true); setError(null);
    try {
      const response = await api<{ job: JobView }>(`/api/jobs/${job.id}`, { method: "PATCH", json: { action } });
      onUpdate?.(response.job);
    } catch (e) { setError(e instanceof Error ? e.message : "Không thay đổi được tác vụ"); }
    finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-cyan-400/15 bg-[#0b1626] p-3" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {active ? <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> : job.state === "succeeded" ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <AlertTriangle className="h-4 w-4 text-amber-300" />}
        <b className={job.state === "partial" ? "text-amber-200" : "text-slate-100"}>{JOB_LABELS[job.state]}</b>
        <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[#a9bad2]">{ROUTE_LABELS[job.route]}</span>
        {role === "owner" && <Link href={`/admin?job=${job.id}`} className="ml-auto text-[#a9bad2] hover:text-cyan-200" aria-label="Mở chi tiết tác vụ"><ExternalLink className="h-3.5 w-3.5" /></Link>}
      </div>
      {active && <div className="my-2 h-1 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${Math.max(3, job.progress)}%` }} /></div>}
      {!compact && <p className="my-2 text-sm font-medium text-slate-200">{job.title}</p>}
      <ol className={`mt-2 space-y-1.5 ${compact ? "text-[11px]" : "text-xs"}`}>
        {job.steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2">
            {s.state === "running" ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-cyan-300" /> : s.state === "succeeded" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" /> : s.state === "failed" ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" /> : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-600" />}
            <div className="min-w-0 flex-1">
              <span className="font-medium text-slate-300">{s.worker}</span><span className="text-[#a9bad2]"> · {s.label}</span>
              {s.note && <p className="mt-0.5 break-words text-[11px] text-slate-400">{s.note}</p>}
            </div>
            {s.durationMs !== undefined && <span className="shrink-0 font-mono text-[10px] text-slate-500">{s.durationMs} ms</span>}
          </li>
        ))}
      </ol>
      {job.error && <p className="mt-2 break-words rounded-lg bg-amber-400/5 px-2 py-1.5 text-[11px] text-amber-200">{job.error}</p>}
      {error && <p className="mt-2 text-xs text-rose-200" role="alert">{error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
        <span>#{job.id.slice(0, 8)} · Lần chạy {job.attempts}/3 · {job.requesterDevice}</span>
        <span className="ml-auto" />
        {controllable && active && <button onClick={() => change("cancel")} disabled={busy} className="flex min-h-8 items-center gap-1 rounded-lg px-2 text-slate-300 hover:bg-white/5 disabled:opacity-40"><X className="h-3 w-3" /> Hủy tác vụ</button>}
        {controllable && ["failed", "partial", "cancelled"].includes(job.state) && <button onClick={() => change("retry")} disabled={busy || job.attempts >= 3} className="flex min-h-8 items-center gap-1 rounded-lg bg-white/5 px-2 text-cyan-200 hover:bg-white/10 disabled:opacity-40"><RotateCcw className="h-3 w-3" /> Thử lại</button>}
      </div>
    </div>
  );
}
