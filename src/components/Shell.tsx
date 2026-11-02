"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Home, Video, ScanText, Brain, MessageCircle, BarChart3, Settings, Bell, User, Power, LogOut, ShieldAlert, Palette, Workflow, Phone } from "lucide-react";
import Robot, { MOOD_LABEL } from "./Robot";
import VoiceCallDialog from "./VoiceCallDialog";
import { useApp } from "./AppState";
import { OfflineBanner } from "./states";

const NAV = [
  { href: "/", label: "Trang chủ", icon: Home },
  { href: "/camera", label: "Camera & Quan sát", icon: Video },
  { href: "/extract", label: "Ảnh & Trích xuất", icon: ScanText },
  { href: "/memory", label: "Trí nhớ", icon: Brain },
  { href: "/alerts", label: "Cảnh báo", icon: ShieldAlert },
  { href: "/chat", label: "Hỏi đáp AI", icon: MessageCircle },
  { href: "/stats", label: "Thống kê", icon: BarChart3 },
  { href: "/settings", label: "Cài đặt", icon: Settings },
  { href: "/orchestration", label: "Điều phối AI", icon: Workflow },
  { href: "/design", label: "Design Freeze", icon: Palette },
];

const TABS = [
  { href: "/", label: "Trang chủ", icon: Home },
  { href: "/camera", label: "Camera", icon: Video },
  { href: "/memory", label: "Trí nhớ", icon: Brain },
  { href: "/chat", label: "Hỏi đáp", icon: MessageCircle },
  { href: "/settings", label: "Tôi", icon: User },
];

type Me = { authenticated: boolean; user?: { name: string; role: string; device: string } };

function fmtUptime(s: number) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} ngày ${h} giờ` : h ? `${h} giờ ${m} phút` : `${m} phút`;
}

export default function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (path === "/login") return <>{children}</>;
  return <AuthenticatedShell>{children}</AuthenticatedShell>;
}

function AuthenticatedShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const { mood, setMood, stopSpeak } = useApp();
  const [me, setMe] = useState<Me>({ authenticated: false });
  const [online, setOnline] = useState<boolean | null>(null);
  const [isOffline, setIsOffline] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const [alerts, setAlerts] = useState(0);
  const [uptime, setUptime] = useState(0);

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        const [mr, r] = await Promise.all([fetch("/api/auth/me", { cache: "no-store" }), fetch("/api/dashboard", { cache: "no-store" })]);
        if (mr.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(path)}`);
          return;
        }
        const mj: Me = await mr.json();
        if (!alive) return;
        setMe(mj);
        if (mj.authenticated) window.dispatchEvent(new Event("dai:config"));
        if (!mj.authenticated) {
          router.replace(`/login?next=${encodeURIComponent(path)}`);
          return;
        }
        setOnline(r.ok);
        if (r.ok) {
          const j = await r.json();
          setAlerts(j.unackedAlerts ?? 0);
          setUptime(j.uptimeSec ?? 0);
        }
      } catch {
        if (alive) setOnline(false);
      }
    };
    ping();
    const t = setInterval(ping, 30000);
    setNow(new Date());
    const c = setInterval(() => setNow(new Date()), 1000);
    const onOff = () => setIsOffline(true);
    const onOn = () => setIsOffline(false);
    window.addEventListener("offline", onOff);
    window.addEventListener("online", onOn);
    setIsOffline(!navigator.onLine);
    return () => {
      alive = false;
      clearInterval(t);
      clearInterval(c);
      window.removeEventListener("offline", onOff);
      window.removeEventListener("online", onOn);
    };
  }, [path, router]);

  const logout = async () => {
    stopSpeak();
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  };

  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const roleLabel: Record<string, string> = { owner: "Chủ hệ thống", operator: "Vận hành", viewer: "Chỉ xem" };

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col gap-3 p-4 lg:flex">
        <Link href="/" className="flex items-center gap-3 px-2">
          <div className="-my-2"><Robot mood={mood} size={52} still /></div>
          <div>
            <div className="text-lg font-extrabold leading-tight text-white">Camera D-AI</div>
            <div className="text-[11px] text-[#a9bad2]">Nhìn · Ghi nhớ · Phân tích · Trả lời</div>
          </div>
        </Link>
        <nav className="glass flex flex-1 flex-col gap-0.5 rounded-2xl p-2" aria-label="Điều hướng chính">
          {NAV.map((n) => {
            const A = isActive(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={A ? "page" : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition ${A ? "bg-cyan-400/15 text-white" : "text-[#c6d4e6] hover:bg-white/5 hover:text-white"}`}
              >
                <n.icon className={`h-5 w-5 ${A ? "text-cyan-300" : "text-slate-400"}`} />
                {n.label}
                {n.href === "/alerts" && alerts > 0 && <span className="ml-auto rounded-full bg-amber-400 px-1.5 text-[10px] font-bold text-black">{alerts}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="glass rounded-2xl p-3 text-xs">
          <div className="font-semibold text-white">{me.user?.name ?? "…"}</div>
          <div className="text-cyan-300">{roleLabel[me.user?.role ?? ""] ?? me.user?.role ?? "—"}</div>
          <div className="mt-1 text-[11px] text-[#a9bad2]">D-AI Bot · {MOOD_LABEL[mood]}</div>
          <button onClick={logout} className="btn btn-ghost mt-2 w-full py-1 text-xs"><LogOut className="h-3.5 w-3.5" /> Đăng xuất</button>
        </div>
        <div className="glass flex items-center gap-3 rounded-2xl p-3">
          <Power className={`h-7 w-7 ${online === false ? "text-rose-400" : "text-emerald-400"}`} />
          <div className="text-xs">
            <div className={online === false ? "text-rose-300" : "text-emerald-300"}>{online === false ? "Mất kết nối máy chủ" : "Hệ thống ổn định"}</div>
            <div className="text-slate-400">Máy chủ: {fmtUptime(uptime)}</div>
          </div>
        </div>
      </aside>

      <header className="sticky top-0 z-20 border-b border-white/5 bg-[#080f1e]/90 backdrop-blur-xl">
        <div className="flex items-center gap-3 px-4 py-2.5 lg:px-6">
          <Link href="/" className="flex items-center gap-2 lg:hidden">
            <div className="-my-2"><Robot mood={mood} size={38} still /></div>
            <span className="font-extrabold text-white">Camera D-AI</span>
          </Link>
          <div
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${online === false ? "border-rose-400/40 bg-rose-500/10 text-rose-300" : "border-emerald-400/40 bg-emerald-500/10 text-emerald-300"}`}
            role="status"
          >
            <span className={`h-2 w-2 rounded-full ${online === false ? "bg-rose-400" : "bg-emerald-400 live-dot"}`} />
            {online === null ? "Đang kết nối…" : online ? "Đang hoạt động" : "Ngoại tuyến"}
          </div>
          {isOffline && <div className="hidden md:block"><OfflineBanner /></div>}
          <div className="hidden text-xs text-[#a9bad2] xl:block">
            {now ? now.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" }) : ""}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => window.dispatchEvent(new Event("dai:call"))} className="rounded-xl bg-emerald-500/15 p-2 text-emerald-300 hover:bg-emerald-500/25" aria-label="Gọi D-AI bằng giọng nói" title="Gọi D-AI"><Phone className="h-5 w-5"/></button>
            <Link href="/alerts" className="relative rounded-xl p-2 hover:bg-white/5" aria-label={`Cảnh báo chưa xử lý: ${alerts}`}>
              <Bell className="h-5 w-5 text-slate-300" />
              {alerts > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-black">{alerts}</span>}
            </Link>
            <span className="hidden rounded-lg bg-white/5 px-2 py-1 text-[11px] text-[#a9bad2] sm:block">
              {me.user?.name ?? "…"} · {roleLabel[me.user?.role ?? ""] ?? ""}
            </span>
            <button onClick={logout} className="rounded-xl p-2 hover:bg-white/5" aria-label="Đăng xuất"><LogOut className="h-5 w-5 text-slate-300" /></button>
          </div>
        </div>
      </header>

      <VoiceCallDialog />
      <main className="px-3 pb-24 pt-4 sm:px-4 lg:px-6 lg:pb-8">
        {isOffline && <div className="mb-3 md:hidden"><OfflineBanner /></div>}
        {children}
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-[#080f1e]/95 backdrop-blur-xl lg:hidden" aria-label="Tab di động">
        <div className="grid grid-cols-5">
          {TABS.map((t) => {
            const A = isActive(t.href);
            return (
              <Link key={t.href} href={t.href} className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 py-2 text-[11px] ${A ? "text-cyan-300" : "text-slate-400"}`}>
                <t.icon className="h-5 w-5" />
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
