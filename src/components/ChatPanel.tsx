"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Send, Volume2, VolumeX, RotateCcw, Square, ChevronDown, AlertTriangle, Calculator, Image as ImageIcon, Trash2, Keyboard } from "lucide-react";
import Robot from "./Robot";
import { useApp } from "./AppState";
import { api } from "@/lib/client";
import { waitForJob } from "@/lib/ai/client";
import type { JobView } from "@/lib/ai/types";
import JobProgress from "./JobProgress";
import useVoiceInput from "./useVoiceInput";
import type { AnswerPayload } from "@/db/schema";

type Msg = { id: number; role: "user" | "assistant"; text: string; answer?: AnswerPayload | null; inputMode?: string; createdAt?: string };

const SUGGESTIONS = [
  "Hôm nay có bao nhiêu khách, khách đầu tiên lúc mấy giờ?",
  "Giờ cao điểm 7 ngày qua là khi nào?",
  "Hôm qua có bao nhiêu xe máy vào bãi?",
  "Tìm cảnh báo trong kho tuần này",
  "Hiện tại còn bao nhiêu người trong cửa hàng?",
  "Có bao nhiêu ảnh và ghi chú đã lưu?",
  "Phân tích toàn bộ camera tuần trước, tìm bất thường và lập báo cáo",
];

function MiniBars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="mt-2 flex h-16 items-end gap-1 rounded-lg bg-black/20 p-2">
      {data.map((d) => (
        <div key={d.label} className="flex flex-1 flex-col items-center gap-0.5" title={`${d.label}: ${d.value}`}>
          <div className="w-full rounded-t bg-gradient-to-t from-cyan-600 to-sky-300" style={{ height: `${(d.value / max) * 40 + 2}px` }} />
          <span className="text-[8px] text-slate-400">{d.label.replace("h", "")}</span>
        </div>
      ))}
    </div>
  );
}

function AnswerCard({ a, onReplay, onOpen }: { a: AnswerPayload; onReplay: () => void; onOpen: (src: string, label: string) => void }) {
  const [showCalc, setShowCalc] = useState(false);
  return (
    <div className="space-y-2">
      {a.execution && <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-slate-400"><Link href="/orchestration" className={`rounded px-1.5 py-0.5 ${a.execution.path === "fast" ? "bg-emerald-400/10 text-emerald-200" : a.execution.path === "fallback" ? "bg-amber-400/10 text-amber-200" : "bg-violet-400/10 text-violet-200"}`}>{a.execution.path === "fast" ? "⚡ Gateway → SQL · không gọi Hermes" : a.execution.path === "fallback" ? "Gateway dự phòng · kết quả giới hạn" : "Hermes → AI Workers"}</Link>{a.execution.durationMs !== undefined && <span>{a.execution.durationMs} ms xử lý phía server</span>}</div>}
      <p className="font-semibold leading-snug text-white">{a.short}</p>
      {a.details.length > 0 && (
        <ul className="space-y-0.5 text-[13px] text-slate-300">
          {a.details.map((d, i) => (
            <li key={i} className="flex gap-2"><span className="text-cyan-400">•</span>{d}</li>
          ))}
        </ul>
      )}
      {a.chart && a.chart.length > 1 && <MiniBars data={a.chart} />}
      {a.evidence.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1 text-[11px] uppercase tracking-wide text-slate-400"><ImageIcon className="h-3 w-3" /> Bằng chứng ({a.evidenceCount} bản ghi)</div>
          <div className="grid grid-cols-3 gap-2">
            {a.evidence.slice(0, 6).map((e, i) => (
              <button key={i} onClick={() => e.thumb && onOpen(e.thumb, `${e.label} · ${e.time}`)} className="group relative overflow-hidden rounded-lg border border-white/10 text-left">
                {e.thumb ? <img src={e.thumb} alt={e.label} className="aspect-video w-full object-cover transition group-hover:scale-105" /> : <div className="aspect-video w-full bg-slate-800" />}
                <span className="absolute bottom-0 left-0 right-0 bg-black/70 px-1 py-0.5 text-center text-[10px] font-semibold">{e.time}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {a.warnings.some((w) => /dữ liệu mẫu|demo/i.test(w)) && <div className="flex items-start gap-1.5 rounded-lg border border-amber-400/25 bg-amber-400/5 px-2 py-1.5 text-[11px] text-amber-200"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{a.warnings.find((w) => /dữ liệu mẫu|demo/i.test(w))}</div>}
      {a.warnings.length > 0 && <details className="rounded-lg border border-white/5 px-2 py-1.5 text-[11px] text-slate-400"><summary className="cursor-pointer text-amber-200/90">Giới hạn & chất lượng dữ liệu ({a.warnings.length} lưu ý)</summary><ul className="mt-2 space-y-1.5">{a.warnings.map((w, i) => <li key={i} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-300" />{w}</li>)}</ul></details>}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        {a.calculation && (
          <button onClick={() => setShowCalc((s) => !s)} className="flex items-center gap-1 rounded-full bg-white/5 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/10">
            <Calculator className="h-3 w-3" /> Chi tiết tính toán <ChevronDown className={`h-3 w-3 transition ${showCalc ? "rotate-180" : ""}`} />
          </button>
        )}
        <button onClick={onReplay} className="flex items-center gap-1 rounded-full bg-white/5 px-2 py-1 text-[11px] text-slate-300 hover:bg-white/10" aria-label="Phát lại giọng nói">
          <RotateCcw className="h-3 w-3" /> Đọc lại
        </button>
        {a.nextActions.map((n) => (
          <Link key={n.href + n.label} href={n.href} className="rounded-full bg-cyan-500/15 px-2 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/25">{n.label} →</Link>
        ))}
      </div>
      {showCalc && a.calculation && (
        <pre className="scroll-thin max-h-40 overflow-auto rounded-lg bg-black/40 p-2 text-[11px] text-cyan-100">{JSON.stringify({ kind: a.kind, value: a.value, ...a.calculation }, null, 2)}</pre>
      )}
    </div>
  );
}

export default function ChatPanel({ compact = false }: { compact?: boolean }) {
  const { mood, setMood, speak, stopSpeak, speaking, voiceOut, setVoiceOut, voiceNotice } = useApp();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; label: string } | null>(null);
  const [showKeyboard, setShowKeyboard] = useState(!compact);
  const [holdMode, setHoldMode] = useState(false);
  const [job, setJob] = useState<JobView | null>(null);
  const pollRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputModeRef = useRef<"text" | "voice">("text");

  useEffect(() => {
    api<Msg[]>("/api/chat").then((m) => setMsgs(compact ? m.slice(-4) : m)).catch(() => {});
    const question = new URLSearchParams(window.location.search).get("question");
    if (question) { setInput(question.slice(0, 1000)); setShowKeyboard(true); }
  }, [compact]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  const finishAnswer = useCallback((message: Msg) => {
    setMsgs((m) => [...m.filter((x) => x.id !== message.id), message]);
    const answer = message.answer;
    setMood("idle");
    speak(answer ? [answer.short, ...(answer.warnings.length ? ["Lưu ý: " + answer.warnings[0]] : [])].join(" ") : message.text);
  }, [setMood, speak]);

  const followJob = useCallback(async (id: string) => {
    pollRef.current?.abort();
    const controller = new AbortController(); pollRef.current = controller;
    setBusy(true); setErr(null); setMood("thinking");
    try {
      const result = await waitForJob<unknown, Msg>(id, setJob, controller.signal);
      if (controller.signal.aborted) return;
      if (result.assistant) finishAnswer(result.assistant);
      else { setErr(result.job.error ?? "Tác vụ chưa có câu trả lời. Xem Điều phối AI để kiểm tra."); setMood("idle"); }
    } catch (e) {
      if (!controller.signal.aborted) { setErr(e instanceof Error ? e.message : "Không theo dõi được tác vụ"); setMood("error"); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }, [finishAnswer, setMood]);

  const ask = useCallback(async (q: string, mode: "text" | "voice" = "text") => {
    const question = q.trim(); if (!question || busy) return;
    setErr(null); setInput(""); stopSpeak(); setBusy(true); setJob(null); setMood("thinking");
    const temp = Date.now();
    setMsgs((list) => [...list, { id: temp, role: "user", text: question, inputMode: mode }]);
    try {
      const r = await api<{ user: Msg; assistant?: Msg; job?: JobView }>("/api/chat", { method: "POST", json: { question, inputMode: mode, requestId: crypto.randomUUID() } });
      setMsgs((list) => [...list.filter((x) => x.id !== temp && x.id !== r.user.id), r.user]);
      if (r.job) { setJob(r.job); await followJob(r.job.id); }
      else if (r.assistant) finishAnswer(r.assistant);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không gửi được câu hỏi");
      setMsgs((list) => list.filter((x) => x.id !== temp)); setMood("error");
    } finally { setBusy(false); }
  }, [busy, setMood, stopSpeak, followJob, finishAnswer]);

  const voice = useVoiceInput({ busy, onText: (t) => { setInput(t); setShowKeyboard(true); }, onFinal: (t) => { inputModeRef.current = "voice"; void ask(t, "voice"); }, onError: setErr });
  const { listening, transcribing, supported: srSupported, levels, start: startListening, stop: stopListening, cancel: cancelListening } = voice;
  const bargeIn = useCallback(() => { stopSpeak(); void startListening(); }, [stopSpeak, startListening]);

  useEffect(() => {
    const onMic = () => startListening();
    const onAsk = (e: Event) => ask(String((e as CustomEvent).detail ?? ""));
    window.addEventListener("dai:mic", onMic);
    window.addEventListener("dai:ask", onAsk);
    return () => {
      window.removeEventListener("dai:mic", onMic);
      window.removeEventListener("dai:ask", onAsk);
    };
  }, [startListening, ask]);

  useEffect(() => () => { pollRef.current?.abort(); }, []);

  const clear = async () => {
    if (!confirm("Xóa lịch sử hỏi đáp của bạn?")) return;
    stopSpeak(); pollRef.current?.abort();
    try {
      if (job && ["queued", "running"].includes(job.state)) await api(`/api/jobs/${job.id}`, { method: "PATCH", json: { action: "cancel" } }).catch(() => {});
      await api("/api/chat", { method: "DELETE" });
      setMsgs([]); setJob(null); setBusy(false);
    } catch (e) { setErr(e instanceof Error ? e.message : "Không xóa được hội thoại"); }
  };

  return (
    <div className={`glass flex flex-col rounded-2xl ${compact ? "h-full min-h-[560px]" : "h-[calc(100vh-150px)] min-h-[520px]"}`}>
      <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
        <div className="-my-3"><Robot mood={mood} size={44} /></div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">Trợ lý AI <span className="text-xs font-normal text-slate-400">· hỏi đáp bằng giọng nói</span></div>
          <div className="text-[11px] text-slate-400">Trả lời từ dữ liệu thật · có bằng chứng · phát loa trên thiết bị này</div>
        </div>
        <button
          onClick={() => setVoiceOut(voiceOut === "device" ? "text" : "device")}
          className="flex items-center gap-1 rounded-lg bg-white/5 px-2 py-1.5 text-[11px] text-slate-200 hover:bg-white/10"
          aria-label="Chọn đầu ra âm thanh"
          title="Đầu ra câu trả lời"
        >
          {voiceOut === "device" ? <Volume2 className="h-4 w-4 text-cyan-300" /> : <VolumeX className="h-4 w-4 text-slate-400" />}
          {voiceOut === "device" ? "Loa: Máy này" : "Chỉ hiện chữ"}
        </button>
        {!compact && (
          <button onClick={clear} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-red-300" aria-label="Xóa lịch sử"><Trash2 className="h-4 w-4" /></button>
        )}
      </div>

      <div ref={listRef} className="scroll-thin flex-1 space-y-3 overflow-y-auto p-4">
        {msgs.length === 0 && (
          <div className="space-y-3 text-sm text-slate-300">
            <p>Xin chào! Mình là <b className="text-cyan-300">D-AI Bot</b>. Bạn có thể hỏi mình về camera, sự kiện, ảnh đã lưu… Mình luôn trả lời kèm số liệu và bằng chứng.</p>
          </div>
        )}
        {msgs.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="anim-fadeup flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-gradient-to-br from-sky-500/80 to-blue-600/80 px-3.5 py-2 text-sm text-white shadow-lg">
                {m.inputMode === "voice" && <Mic className="mr-1 inline h-3 w-3 opacity-80" />}
                {m.text}
              </div>
            </div>
          ) : (
            <div key={m.id} className="anim-fadeup flex gap-2">
              <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-cyan-500/20 text-[10px] font-bold text-cyan-300">AI</div>
              <div className="max-w-[92%] flex-1 rounded-2xl rounded-tl-md border border-cyan-400/15 bg-[#0c1a3a]/80 px-3.5 py-2.5 text-sm">
                {m.answer ? <AnswerCard a={m.answer} onReplay={() => speak(m.answer!.short)} onOpen={(src, label) => setLightbox({ src, label })} /> : m.text}
              </div>
            </div>
          )
        )}
        {job && (["queued", "running", "failed", "cancelled"].includes(job.state) ? <JobProgress job={job} compact onUpdate={(updated) => { setJob(updated); if (updated.state === "queued") void followJob(updated.id); }} /> : <details className="rounded-xl border border-white/5 px-3 py-2 text-[11px] text-slate-400"><summary className="cursor-pointer">Xem tiến trình điều phối · #{job.id.slice(0, 8)}</summary><div className="mt-2"><JobProgress job={job} compact onUpdate={(updated) => { setJob(updated); if (updated.state === "queued") void followJob(updated.id); }} /></div></details>)}
        {busy && !job && (
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <div className="grid h-7 w-7 place-items-center rounded-full bg-cyan-500/20 text-[10px] font-bold text-cyan-300">AI</div>
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 rounded-full bg-cyan-300 anim-blink-fast" style={{ animationDelay: `${i * 0.2}s` }} />)}
            </span>
            Đang truy vấn dữ liệu…
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-white/5 p-3">
        {!compact || msgs.length < 2 ? (
          <div className="scroll-thin flex gap-1.5 overflow-x-auto pb-1">
            {SUGGESTIONS.slice(0, compact ? 3 : 7).map((s) => (
              <button key={s} onClick={() => ask(s)} className="shrink-0 rounded-full border border-cyan-400/20 bg-cyan-500/5 px-2.5 py-1 text-[11px] text-cyan-100 hover:bg-cyan-500/15">{s}</button>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-1 text-[10px] text-slate-500"><span>{voice.source}</span><Link href="/orchestration" className="text-cyan-300 hover:underline">Gateway & AI Workers →</Link></div>
        {transcribing && <div className="flex items-center gap-2 text-xs text-cyan-200"><span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300" /> Voice Worker đang nhận dạng lời nói…</div>}
        {voiceNotice && <p className="text-[10px] text-slate-400">{voiceNotice}</p>}
        {err && <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-200" role="alert">{err}</div>}

        {listening && (
          <div className="flex h-10 items-center justify-center gap-[3px] rounded-xl bg-violet-500/10" aria-live="polite">
            {levels.map((l, i) => <span key={i} className="w-1 rounded-full bg-gradient-to-t from-violet-500 to-cyan-300" style={{ height: `${l * 36}px` }} />)}
            <span className="ml-3 text-xs text-violet-200">Đang nghe…</span>
          </div>
        )}

        {showKeyboard && (
          <form onSubmit={(e) => { e.preventDefault(); ask(input, inputModeRef.current); inputModeRef.current = "text"; }} className="flex gap-2">
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Nhập câu hỏi về camera…" className="input" aria-label="Câu hỏi" />
            <button type="submit" disabled={!input.trim() || busy} className="btn btn-primary px-3" aria-label="Gửi"><Send className="h-4 w-4" /></button>
          </form>
        )}

        {listening && (
          <div className="flex items-center justify-center gap-2">
            <button onClick={cancelListening} className="btn btn-ghost py-1 text-xs">Hủy ghi âm</button>
            <button onClick={stopListening} className="btn btn-primary py-1 text-xs">Dừng & gửi</button>
          </div>
        )}
        {speaking && !listening && (
          <button onClick={bargeIn} className="mx-auto flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/15 px-3 py-1 text-xs text-violet-100">
            <Mic className="h-3.5 w-3.5" /> Ngắt lời & nói tiếp
          </button>
        )}
        <div className="flex items-center justify-center gap-6 pt-1">
          <div className="flex flex-col items-center gap-1">
            <button onClick={() => setShowKeyboard((s) => !s)} className="grid h-11 w-11 place-items-center rounded-full bg-white/5 text-slate-300 hover:bg-white/10" aria-label="Bàn phím">
              <Keyboard className="h-5 w-5" />
            </button>
            <button
              onClick={() => setHoldMode((m) => !m)}
              className={`rounded-full px-2 py-0.5 text-[10px] ${holdMode ? "bg-cyan-400/20 text-cyan-200" : "text-slate-500"}`}
              title="Chế độ giữ để nói"
            >
              {holdMode ? "Giữ để nói" : "Chạm để nói"}
            </button>
          </div>
          <button
            onPointerDown={(event) => {
              if (holdMode && !listening && !busy) { event.currentTarget.setPointerCapture(event.pointerId); void startListening(); }
            }}
            onPointerUp={() => { if (holdMode) stopListening(); }}
            onPointerCancel={() => { if (holdMode) cancelListening(); }}
            onClick={() => {
              if (holdMode) return;
              if (listening) stopListening();
              else startListening();
            }}
            disabled={busy || transcribing || !srSupported}
            title={srSupported ? "Nhấn để nói, nhấn lần nữa để gửi" : "Trình duyệt chưa hỗ trợ nhận giọng nói"}
            className={`relative grid h-16 w-16 place-items-center rounded-full text-white transition disabled:opacity-40 ${
              listening ? "bg-gradient-to-br from-violet-500 to-fuchsia-600 shadow-[0_0_30px_rgba(167,139,250,0.7)]" : "bg-gradient-to-br from-cyan-400 to-blue-600 shadow-[0_0_30px_rgba(34,211,238,0.55)] hover:scale-105"
            }`}
            aria-label={listening ? "Dừng ghi âm và gửi" : "Nhấn để nói"}
            aria-pressed={listening}
          >
            {listening && <span className="absolute inset-0 rounded-full border-2 border-violet-300 anim-ring" style={{ left: "50%" }} />}
            {listening ? <Square className="h-6 w-6" /> : <Mic className="h-7 w-7" />}
          </button>
          <button onClick={() => (speaking ? stopSpeak() : undefined)} disabled={!speaking} className="grid h-11 w-11 place-items-center rounded-full bg-white/5 text-slate-300 hover:bg-white/10 disabled:opacity-40" aria-label="Dừng đọc">
            <VolumeX className="h-5 w-5" />
          </button>
        </div>
        <p className="text-center text-[11px] text-slate-400">{listening ? "Đang nghe · nhấn ■ để gửi, hoặc Hủy" : speaking ? "Đang đọc câu trả lời · chạm mic để ngắt lời" : srSupported ? (holdMode ? "Giữ mic để nói, thả ra để gửi" : "Chạm mic để nói, chạm lần nữa để gửi") : "Thiết bị chưa hỗ trợ giọng nói — dùng nhập văn bản"}</p>
      </div>

      {lightbox && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4" onClick={() => setLightbox(null)} role="dialog" aria-label="Xem bằng chứng">
          <figure className="max-w-3xl">
            <img src={lightbox.src} alt={lightbox.label} className="max-h-[75vh] rounded-xl border border-white/10" />
            <figcaption className="mt-2 text-center text-sm text-slate-300">{lightbox.label}</figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}
