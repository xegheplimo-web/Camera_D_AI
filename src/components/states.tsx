"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Loader2, Inbox, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";

/** Required UI states (spec section F), reused by every screen. */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/10 px-4 py-10 text-center">
      <Inbox className="h-8 w-8 text-slate-500" />
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {hint && <p className="max-w-md text-xs text-slate-400">{hint}</p>}
      {action}
    </div>
  );
}

export function LoadingState({ label = "Đang tải…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-300" role="status" aria-live="polite">
      <Loader2 className="h-4 w-4 animate-spin text-cyan-300" /> {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-rose-400/40 bg-rose-500/10 px-4 py-6 text-center" role="alert">
      <AlertTriangle className="h-6 w-6 text-rose-300" />
      <p className="text-sm text-rose-100">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="btn btn-ghost mt-1">
          <RefreshCw className="h-4 w-4" /> Thử lại
        </button>
      )}
    </div>
  );
}

export function NoPermissionState({ what = "thao tác này" }: { what?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-6 text-center">
      <ShieldAlert className="h-6 w-6 text-amber-300" />
      <p className="text-sm text-amber-100">Vai trò hiện tại không đủ quyền cho {what}.</p>
      <p className="text-xs text-amber-200/70">Liên hệ chủ hệ thống để được cấp quyền.</p>
    </div>
  );
}

export function OfflineBanner() {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-400/30 bg-slate-500/15 px-3 py-2 text-xs text-slate-200" role="status">
      <WifiOff className="h-4 w-4" /> Mất kết nối mạng. Đang hiển thị dữ liệu đã tải; dữ liệu mới sẽ không cập nhật.
    </div>
  );
}

export function PendingBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
      Chưa hỗ trợ
    </span>
  );
}
