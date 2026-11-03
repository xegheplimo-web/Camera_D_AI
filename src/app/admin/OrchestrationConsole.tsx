"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Activity, ArrowDown, ArrowRight, AudioLines, Check, CheckCircle2, ChevronRight, Circle, Database, Eye, FileScan, GitBranch, Loader2, LockKeyhole, PlugZap, RefreshCw, ScanEye, Server, ShieldCheck, Workflow, Zap } from "lucide-react";
import { api } from "@/lib/client";
import type { JobView, ServiceName } from "@/lib/ai/types";
import JobProgress, { JOB_LABELS, ROUTE_LABELS } from "@/components/JobProgress";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui";

type Service = { name: ServiceName; label: string; configured: boolean; remote: boolean; state: string; checkedAt: string | null; latencyMs: number | null; lastError: string | null; configError: string | null; stt: boolean; tts: boolean };
type DetectorView = { running: boolean; envEnabled: boolean; settingEnabled: boolean | null; lastTickAt: string | null; lastError: string | null; eventsCreated: number; cameras: { cameraId: number; frames: number; events: number; lastScore: number | null; lastError: string | null }[] };
type Status = { services: Service[]; settings: { hermesEnabled: boolean; remoteProcessingAllowed: boolean }; fastPath: { state: string; count: number }; stats: { state: string; count: number }[]; canManage: boolean; isOwner: boolean; dispatchMode: string; maxConcurrency: number; maxAttempts: number; detector?: DetectorView };
const ICONS = { hermes: Workflow, vision: Eye, ocr: FileScan, voice: AudioLines };
const DESCRIPTIONS = { hermes: "Chọn công cụ · lập kế hoạch · điều phối", vision: "Nhận diện · đếm · phân tích ảnh/ROI", ocr: "Đọc chữ tiếng Việt · bảng · biển số", voice: "Nhận giọng nói · tạo âm thanh trả lời" };
const STATE_LABELS: Record<string, string> = { not_configured: "Chưa cấu hình", unknown: "Chưa kiểm tra", online: "Kết nối thành công", offline: "Mất kết nối", cooldown: "Đang tạm nghỉ" };

export default function OrchestrationConsole() {
  const [status, setStatus] = useState<Status | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<ServiceName | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const [s, list] = await Promise.all([api<Status>("/api/orchestration"), api<{ items: JobView[] }>(`/api/jobs?scope=${scope}`)]);
      setStatus(s); setJobs(list.items); setError(null);
      setSelected((id) => id ?? list.items[0]?.id ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "Không tải được trạng thái dịch vụ AI"); }
    finally { setLoading(false); }
  }, [scope]);

  useEffect(() => {
    setSelected(new URLSearchParams(window.location.search).get("job"));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => load(true), 5000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!selected) return;
    const current = jobs.find((j) => j.id === selected);
    if (!current || !["queued", "running"].includes(current.state)) return;
    // Reading the selected active job also resumes a lease-expired job in request-driven deployments.
    api<{ job: JobView }>(`/api/jobs/${selected}`).then(({ job }) => setJobs((list) => list.map((j) => j.id === job.id ? job : j))).catch(() => {});
  }, [selected, jobs.map((j) => `${j.id}:${j.updatedAt}`).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const probe = async (name: ServiceName) => {
    setChecking(name); setNotice(null);
    try {
      const r = await api<{ ok: boolean; message?: string }>("/api/orchestration", { method: "POST", json: { action: "probe", service: name } });
      setNotice(`${status?.services.find((s) => s.name === name)?.label}: ${r.message ?? "Đã kiểm tra"}`);
      await load(true);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Kiểm tra kết nối thất bại"); }
    finally { setChecking(null); }
  };
  const change = async (key: "hermesEnabled" | "remoteProcessingAllowed", value: boolean) => {
    if (key === "remoteProcessingAllowed" && value && !confirm("Cho phép máy chủ gửi yêu cầu/dữ liệu đến AI nằm ngoài mạng riêng? Ảnh trích xuất vẫn cần sự đồng ý riêng ở màn Trích xuất.")) return;
    setSaving(true);
    try { await api("/api/settings", { method: "PATCH", json: { [key]: value } }); await load(true); }
    catch (e) { setNotice(e instanceof Error ? e.message : "Không lưu được"); }
    finally { setSaving(false); }
  };
  const selectedJob = jobs.find((j) => j.id === selected) ?? jobs[0];
  const active = status?.stats.filter((s) => ["queued", "running"].includes(s.state)).reduce((n, s) => n + s.count, 0) ?? 0;
  const workerCount = status?.services.filter((s) => s.name !== "hermes" && s.configured).length ?? 0;

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-cyan-300"><GitBranch className="h-3.5 w-3.5" /> Dịch vụ AI</div>
          <h1 className="text-2xl font-bold tracking-tight">Trạng thái xử lý</h1>
          <p className="mt-1 text-sm text-[#a9bad2]">Xử lý nhanh tại chỗ, chỉ dùng trợ lý AI khi cần lập kế hoạch.</p>
        </div>
        <button onClick={() => load()} className="btn btn-ghost"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Làm mới</button>
      </div>
      {error && <ErrorState message={error} onRetry={() => load()} />}
      {notice && <div className="flex items-start gap-2 rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-3 text-xs text-slate-200" role="status"><Activity className="h-4 w-4 shrink-0 text-cyan-300" />{notice}</div>}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          { icon: Zap, label: "Đường xử lý nhanh", value: status ? "Sẵn sàng" : "…", detail: `${status?.fastPath.count ?? 0} câu hỏi đã xử lý · không gọi trợ lý AI`, color: "text-emerald-300" },
          { icon: Workflow, label: "Trợ lý AI", value: !status ? "…" : !status.settings.hermesEnabled ? "Tạm dừng" : status.services.find((s) => s.name === "hermes")?.configured ? "Đã cấu hình" : "Chưa kết nối", detail: "Chỉ tham gia khi cần lập kế hoạch", color: "text-violet-300" },
          { icon: Server, label: "Bộ xử lý ảnh/âm thanh", value: `${workerCount} / 3`, detail: "Ảnh · văn bản · giọng nói được cấu hình", color: "text-cyan-300" },
          { icon: Activity, label: "Tác vụ đang chờ / chạy", value: String(active), detail: `Tối đa ${status?.maxConcurrency ?? 2} tác vụ nặng đồng thời`, color: "text-amber-300" },
        ].map((c) => <div key={c.label} className="glass p-4"><div className="flex items-center justify-between gap-2 text-xs text-[#a9bad2]">{c.label}<c.icon className={`h-4 w-4 ${c.color}`} /></div><div className={`mt-3 text-xl font-bold ${c.color}`}>{c.value}</div><div className="mt-1 text-[11px] text-slate-400">{c.detail}</div></div>)}
      </div>

      <section className="glass p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Hai đường xử lý, một trải nghiệm</h2><span className="flex items-center gap-1.5 text-[11px] text-[#a9bad2]"><ShieldCheck className="h-3.5 w-3.5 text-emerald-300" /> Quyền truy cập luôn do máy chủ kiểm tra</span></div>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.035] p-4">
            <div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-400/10"><Zap className="h-4 w-4 text-emerald-300" /></span><div><div className="text-sm font-semibold text-emerald-200">Đường xử lý nhanh</div><div className="text-[11px] text-slate-400">Thao tác trực tiếp và truy vấn xác định</div></div></div>
            <div className="my-4 flex flex-wrap items-center gap-2 text-xs"><span className="rounded-lg border border-white/10 px-3 py-2">Camera D-AI</span><ArrowRight className="h-3.5 w-3.5 text-slate-500" /><span className="rounded-lg border border-emerald-400/30 px-3 py-2 text-emerald-200">Máy chủ</span><ArrowRight className="h-3.5 w-3.5 text-slate-500" /><span className="rounded-lg border border-white/10 px-3 py-2">SQL / Media / Voice</span></div>
            <div className="space-y-1.5 text-xs text-[#a9bad2]">{["Xem camera, chụp ảnh, lưu ghi chú", "Đếm lượt đã ghi, tìm sự kiện, đọc thống kê", "Gọi bộ xử lý ảnh/âm thanh cho một yêu cầu chuyên môn"].map((t) => <div key={t} className="flex items-start gap-2"><Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-300" />{t}</div>)}</div>
            <Link href={`/chat?question=${encodeURIComponent("Hôm nay có bao nhiêu khách?")}`} className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-emerald-200 hover:underline">Thử câu hỏi nhanh <ChevronRight className="h-3.5 w-3.5" /></Link>
          </div>
          <div className="rounded-2xl border border-violet-400/20 bg-violet-400/[0.035] p-4">
            <div className="flex items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-xl bg-violet-400/10"><Workflow className="h-4 w-4 text-violet-300" /></span><div><div className="text-sm font-semibold text-violet-200">Trợ lý AI · Điều phối theo nhu cầu</div><div className="text-[11px] text-slate-400">Yêu cầu nhiều bước, có tiến độ và bằng chứng</div></div></div>
            <div className="my-4 flex flex-wrap items-center gap-2 text-xs"><span className="rounded-lg border border-white/10 px-3 py-2">Máy chủ</span><ArrowRight className="h-3.5 w-3.5 text-slate-500" /><span className="rounded-lg border border-violet-400/30 px-3 py-2 text-violet-200">Trợ lý AI</span><ArrowRight className="h-3.5 w-3.5 text-slate-500" /><span className="rounded-lg border border-white/10 px-3 py-2">Bộ xử lý ảnh/âm thanh</span></div>
            <div className="space-y-1.5 text-xs text-[#a9bad2]">{["Kế hoạch theo danh sách công cụ cho phép, không SQL tùy ý", "Chạy chuyên môn ở server, không tải model xuống client", "Trợ lý AI lỗi → báo cáo SQL giới hạn, không bịa phân tích video"].map((t) => <div key={t} className="flex items-start gap-2"><Check className="mt-0.5 h-3 w-3 shrink-0 text-violet-300" />{t}</div>)}</div>
            <Link href={`/chat?question=${encodeURIComponent("Phân tích toàn bộ camera tuần trước, tìm bất thường và lập báo cáo")}`} className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-violet-200 hover:underline">Thử tác vụ phân tích <ChevronRight className="h-3.5 w-3.5" /></Link>
          </div>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">Kết nối dịch vụ</h2><span className="text-[11px] text-slate-400">Không tự coi “đã cấu hình” là “đang hoạt động”</span></div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {status?.services.map((service) => {
            const Icon = ICONS[service.name];
            return <div key={service.name} className="glass flex flex-col p-4"><div className="flex items-center justify-between"><Icon className={`h-5 w-5 ${service.name === "hermes" ? "text-violet-300" : "text-cyan-300"}`} /><Badge color={service.state === "online" ? "emerald" : service.state === "offline" || service.state === "cooldown" ? "amber" : "slate"}>{STATE_LABELS[service.state] ?? service.state}</Badge></div><h3 className="mt-3 font-semibold">{service.label}</h3><p className="mt-1 text-[11px] text-[#a9bad2]">{DESCRIPTIONS[service.name]}</p><div className="mt-3 space-y-1 text-[10px] text-slate-400"><div>{service.configured ? service.remote ? "Máy chủ ngoài mạng riêng · cần đồng ý" : "Máy chủ trong mạng riêng" : "Chưa có endpoint/model phía máy chủ"}</div>{service.checkedAt && <div>Lần kiểm tra: {new Date(service.checkedAt).toLocaleTimeString("vi-VN")} · {service.latencyMs ?? "—"} ms</div>}{service.configError && <div className="text-amber-300">{service.configError}</div>}</div><button disabled={!status.canManage || !service.configured || checking !== null} onClick={() => probe(service.name)} className="btn btn-ghost mt-4 w-full text-xs">{checking === service.name ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />} Kiểm tra kết nối</button></div>;
          })}
          {loading && !status && <div className="md:col-span-2 xl:col-span-4"><LoadingState /></div>}
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <section className="glass min-w-0 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Tác vụ AI</h2>{status?.isOwner && <select value={scope} onChange={(e) => setScope(e.target.value as "mine" | "all")} className="input w-auto py-1 text-xs" aria-label="Phạm vi tác vụ"><option value="mine">Của tôi</option><option value="all">Toàn bộ · chủ hệ thống</option></select>}</div>
          {!jobs.length && !loading && <EmptyState title="Chưa có tác vụ AI" hint="Hỏi robot một câu phân tích nhiều bước hoặc chạy trích xuất ảnh. Truy vấn SQL nhanh không cần vào hàng đợi." action={<Link href="/chat" className="btn btn-ghost mt-2 text-xs">Hỏi D-AI Bot <ArrowRight className="h-3.5 w-3.5" /></Link>} />}
          {jobs.length > 0 && <div className="grid gap-3 lg:grid-cols-[220px_1fr]"><div className="scroll-thin max-h-[520px] space-y-1 overflow-auto">{jobs.map((j) => <button key={j.id} onClick={() => setSelected(j.id)} className={`w-full rounded-xl border p-3 text-left transition ${selectedJob?.id === j.id ? "border-cyan-400/30 bg-cyan-400/5" : "border-transparent hover:bg-white/5"}`}><div className="mb-1 flex items-center gap-1.5 text-[10px] text-[#a9bad2]">{["queued", "running"].includes(j.state) ? <Loader2 className="h-3 w-3 animate-spin text-cyan-300" /> : <Circle className="h-2 w-2 fill-current" />}{JOB_LABELS[j.state]}<span className="ml-auto">{j.kind === "report" ? "Báo cáo" : "Ảnh"}</span></div><p className="line-clamp-2 text-xs font-medium text-slate-200">{j.title}</p><div className="mt-1 text-[10px] text-slate-400">{new Date(j.createdAt).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })} · {ROUTE_LABELS[j.route]}</div></button>)}</div><div className="min-w-0 space-y-3">{selectedJob && <JobProgress job={selectedJob} onUpdate={(j) => { setJobs((list) => list.map((old) => old.id === j.id ? j : old)); load(true); }} />}{selectedJob?.result?.answer && <div className="rounded-xl border border-white/10 p-3"><p className="text-sm font-medium">{selectedJob.result.answer.short}</p><div className="mt-2 flex flex-wrap gap-2">{selectedJob.result.answer.nextActions.map((a) => <Link key={a.href} href={a.href} className="text-xs text-cyan-200 hover:underline">{a.label} →</Link>)}</div></div>}{selectedJob?.result?.extractionId && <Link href={`/extract?job=${selectedJob.id}`} className="btn btn-ghost text-xs">Mở kết quả trích xuất <ArrowRight className="h-3.5 w-3.5" /></Link>}</div></div>}
        </section>
        <aside className="space-y-3">
          <div className="glass space-y-3 p-4"><h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-cyan-300" /> Chính sách điều phối</h2>
          {status?.detector && (
            <div className="rounded-xl border border-white/10 p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-semibold"><ScanEye className="h-3.5 w-3.5 text-emerald-300" /> Detector camera</span>
                <Badge color={status.detector.running && status.detector.settingEnabled ? "emerald" : status.detector.running ? "amber" : "slate"}>
                  {status.detector.running ? (status.detector.settingEnabled ? "đang chạy" : "chạy · setting tắt") : status.detector.envEnabled ? "dừng" : "env tắt"}
                </Badge>
              </div>
              <div className="mt-1.5 space-y-0.5 text-[11px] text-slate-400">
                <div>Tick cuối: {status.detector.lastTickAt ? new Date(status.detector.lastTickAt).toLocaleTimeString("vi-VN") : "—"} · Sự kiện live đã tạo: {status.detector.eventsCreated}</div>
                <div>{status.detector.cameras.length} camera RTSP đang theo dõi{status.detector.cameras.some((c) => c.lastError) ? " · có lỗi lấy frame" : ""}</div>
              </div>
            </div>
          )}
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-cyan-400" checked={status?.settings.hermesEnabled ?? true} disabled={!status?.canManage || saving} onChange={(e) => change("hermesEnabled", e.target.checked)} /><span>Cho phép trợ lý AI lập kế hoạch<span className="mt-1 block text-[11px] text-slate-400">Tắt không ảnh hưởng camera, ghi chú hay SQL.</span></span></label><label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-cyan-400" checked={status?.settings.remoteProcessingAllowed ?? false} disabled={!status?.isOwner || saving} onChange={(e) => change("remoteProcessingAllowed", e.target.checked)} /><span>Cho phép AI ngoài mạng riêng<span className="mt-1 block text-[11px] text-slate-400">Mặc định tắt. Chỉ chủ hệ thống được thay đổi.</span></span></label><div className="border-t border-white/5 pt-3 text-[11px] text-[#a9bad2]">Job được lưu PostgreSQL · lease 90 giây · tối đa 3 lần chạy · 2 job nặng đồng thời. Âm thanh luôn về thiết bị gửi câu hỏi.</div></div>
          <details className="glass p-4 text-xs"><summary className="cursor-pointer font-semibold text-slate-200">Cấu hình máy chủ <span className="ml-1 text-slate-400">.env</span></summary><div className="mt-3 space-y-2 text-[#a9bad2]"><p>Đặt endpoint và API key trên server, không đưa vào trình duyệt:</p><div className="space-y-1 break-all rounded-lg bg-black/20 p-2 font-mono text-[10px]"><div>HERMES_BASE_URL</div><div>HERMES_API_KEY</div><div>DAI_VISION_BASE_URL / MODEL</div><div>DAI_OCR_BASE_URL / MODEL</div><div>DAI_VOICE_BASE_URL</div><div>DAI_VOICE_STT_MODEL / TTS_MODEL</div></div><p>Trợ lý AI: API OpenAI-compatible + profile chỉ lập kế hoạch, không cấp terminal/file tools. Xem <b>docs/HERMES_ARCHITECTURE.md</b> trong repository.</p><p>Chế độ hiện tại: {status?.dispatchMode ?? "…"}. Muốn tiếp tục chạy khi không mở app, cần bật dispatcher được giám sát trên máy chủ.</p></div></details>
          <div className="flex items-start gap-2 px-2 text-[11px] text-slate-400"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Không gửi API key, SQL tùy ý hoặc lệnh điều khiển loa sang thiết bị khác.</div>
        </aside>
      </div>
    </div>
  );
}
