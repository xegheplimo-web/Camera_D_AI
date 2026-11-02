"use client";

import type { ReactNode } from "react";
import { EVENT_TYPES } from "@/lib/labels";

const BADGE: Record<string, string> = {
  emerald: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  sky: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  rose: "bg-rose-500/20 text-rose-300 border-rose-500/30",
  indigo: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
  orange: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  cyan: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  violet: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  fuchsia: "bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30",
  teal: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  amber: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  slate: "bg-slate-500/20 text-slate-300 border-slate-500/30",
};

export function Badge({ color = "slate", children }: { color?: string; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${BADGE[color] ?? BADGE.slate}`}>{children}</span>;
}

export function EventBadge({ type }: { type: string }) {
  const t = EVENT_TYPES[type] ?? { label: type, color: "slate" };
  return <Badge color={t.color}>{t.label}</Badge>;
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass rounded-2xl p-4 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="font-semibold text-white">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export type EventItem = {
  id: number;
  type: string;
  label: string;
  note?: string | null;
  happenedAt: string;
  thumb: string | null;
  camera: string;
  priority: string;
  tags: string[];
  confidence?: number | null;
  source?: string;
  clientReported?: boolean;
  ackAt?: string | null;
};

export function EventRow({ e, onOpen, highlight }: { e: EventItem; onOpen?: (e: EventItem) => void; highlight?: boolean }) {
  return (
    <button onClick={() => onOpen?.(e)} className={`flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-white/5 ${highlight ? "anim-highlight" : ""}`}>
      {e.thumb ? (
        e.type === "clip" ? (
          <div className="grid h-11 w-16 shrink-0 place-items-center rounded-lg bg-fuchsia-900/40 text-[10px] text-fuchsia-200">CLIP</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={e.thumb} alt="" className="h-11 w-16 shrink-0 rounded-lg object-cover" />
        )
      ) : (
        <div className="h-11 w-16 shrink-0 rounded-lg bg-slate-800" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="font-mono text-slate-200">{new Date(e.happenedAt).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</span>
          {e.priority !== "normal" && <Badge color={e.priority === "critical" ? "orange" : "amber"}>{e.priority === "critical" ? "Khẩn" : "Quan trọng"}</Badge>}
          {e.clientReported && <Badge color="slate">client báo</Badge>}
          {e.source === "demo" && <Badge color="slate">mẫu</Badge>}
          {e.source === "live" && <Badge color="emerald">live</Badge>}
        </div>
        <div className="truncate text-sm text-slate-100">{e.label}</div>
      </div>
      <EventBadge type={e.type} />
    </button>
  );
}

export function StatTile({ icon, value, label, color }: { icon: ReactNode; value: ReactNode; label: string; color: string }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-xl border p-2.5 text-center ${color}`}>
      <div className="mb-1">{icon}</div>
      <div className="text-xl font-bold leading-none text-white">{value}</div>
      <div className="mt-1 text-[11px] text-slate-300">{label}</div>
    </div>
  );
}

export function Modal({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: ReactNode; title?: string }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" onClick={onClose} role="dialog" aria-label={title}>
      <div className="glass-strong scroll-thin max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl p-4" onClick={(e) => e.stopPropagation()}>
        {title && <h3 className="mb-3 text-lg font-semibold">{title}</h3>}
        {children}
      </div>
    </div>
  );
}
