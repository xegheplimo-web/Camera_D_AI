"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LogIn, Loader2, ShieldCheck } from "lucide-react";
import Robot from "@/components/Robot";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42A11.58 11.58 0 0 0 12 0a12 12 0 0 0-10.71 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const sp = useSearchParams();
  const googleErr =
    sp.get("google") === "denied" ? "Email Google chưa được cấp quyền. Liên hệ quản trị."
    : sp.get("google") === "error" ? "Đăng nhập Google thất bại. Thử lại sau."
    : null;
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
          {googleErr && (
            <div className="mb-3 rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100" role="alert">
              {googleErr}
            </div>
          )}
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

          <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-[#64748b]">
            <span className="h-px flex-1 bg-white/10" /> hoặc <span className="h-px flex-1 bg-white/10" />
          </div>
          <a href="/api/auth/google" className="btn btn-ghost w-full">
            <GoogleMark /> Đăng nhập bằng Google
          </a>

          <div className="mt-5 rounded-xl border border-cyan-400/25 bg-cyan-500/10 p-3 text-xs text-cyan-100">
            <p className="font-semibold">Tài khoản hệ thống</p>
            <p className="mt-1">
              Ba mức tài khoản <b>owner</b> (toàn quyền, bao gồm cả quản trị camera), <b>operator</b> (vận hành, không xóa dữ liệu) và <b>viewer</b> (chỉ xem và hỏi đáp).
              Mật khẩu bắt buộc được cấu hình qua <span className="font-mono">ADMIN_PASSWORD</span>, <span className="font-mono">OPERATOR_PASSWORD</span>, <span className="font-mono">VIEWER_PASSWORD</span> trong biến môi trường của lần triển khai (mỗi mật khẩu từ 12 ký tự, đôi một khác nhau) — hệ thống <b>không tạo tài khoản với mật khẩu mặc định</b>.
            </p>
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
