"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LogIn, Loader2, ShieldCheck } from "lucide-react";
import Robot from "@/components/Robot";

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login, password }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.title || `Đăng nhập thất bại (${res.status})`);
      const next = sp.get("next");
      router.replace(next && next.startsWith("/") ? next : "/");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không đăng nhập được");
    } finally {
      setBusy(false);
    }
  };

  const fill = (l: string, p: string) => {
    setLogin(l);
    setPassword(p);
    setErr(null);
  };

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-4xl overflow-hidden rounded-3xl border border-white/10 bg-[#111d31] shadow-[0_30px_80px_-40px_rgba(0,0,0,1)] md:grid md:grid-cols-2">
        <div className="relative flex flex-col items-center justify-center gap-2 bg-[#0b1526] p-8 text-center">
          <Robot mood="idle" size={190} />
          <h1 className="text-2xl font-extrabold text-white">Camera D-AI</h1>
          <p className="text-sm text-[#a9bad2]">Trợ lý camera AI có trí nhớ — Nhìn, Ghi nhớ, Phân tích, Trả lời</p>
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-cyan-400/30 px-3 py-1 text-[11px] text-cyan-200">
            <ShieldCheck className="h-3.5 w-3.5" /> Kết nối được xác thực · mic chỉ bật khi bạn yêu cầu
          </p>
        </div>
        <div className="p-6 sm:p-8">
          <h2 className="text-lg font-semibold text-white">Đăng nhập</h2>
          <p className="mb-4 text-xs text-[#a9bad2]">Dùng tài khoản được cấp cho máy Windows hoặc điện thoại của bạn.</p>
          <form onSubmit={submit} className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-[#a9bad2]">Tên đăng nhập</span>
              <input value={login} onChange={(e) => setLogin(e.target.value)} className="input" autoComplete="username" required aria-label="Tên đăng nhập" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-[#a9bad2]">Mật khẩu</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" autoComplete="current-password" required aria-label="Mật khẩu" />
            </label>
            {err && (
              <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100" role="alert">
                {err}
              </div>
            )}
            <button type="submit" disabled={busy} className="btn btn-primary w-full">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} {busy ? "Đang kiểm tra…" : "Đăng nhập"}
            </button>
          </form>

          <div className="mt-5 rounded-xl border border-amber-400/25 bg-amber-500/10 p-3 text-xs text-amber-100">
            <p className="font-semibold">Tài khoản demo của môi trường phát triển</p>
            <p className="mt-1">Mật khẩu lấy từ biến môi trường khi triển khai; nếu chưa đặt, hệ thống dùng giá trị mặc định dưới đây và bạn phải đổi trước khi cho người khác truy cập.</p>
            <div className="mt-2 grid gap-1">
              {[
                ["owner", "CameraDAI!2026", "Chủ hệ thống · toàn quyền"],
                ["operator", "Operator!2026", "Vận hành · không xóa dữ liệu"],
                ["viewer", "Viewer!2026", "Chỉ xem và hỏi đáp"],
              ].map(([l, p, d]) => (
                <button key={l} type="button" onClick={() => fill(l, p)} className="flex items-center justify-between gap-2 rounded-lg bg-black/25 px-2 py-1.5 text-left hover:bg-black/40">
                  <span>
                    <b className="text-white">{l}</b> / <span className="font-mono">{p}</span>
                    <span className="block text-[10px] text-amber-200/80">{d}</span>
                  </span>
                  <span className="text-[10px] text-cyan-300">Điền</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="grid min-h-screen place-items-center text-slate-400">Đang tải…</div>}>
      <LoginForm />
    </Suspense>
  );
}
