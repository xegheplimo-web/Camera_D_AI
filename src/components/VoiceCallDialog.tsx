"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Mic, MicOff, Volume2, VolumeX, Send, Square, RotateCcw, X } from "lucide-react";
import Robot from "./Robot";
import { useApp } from "./AppState";
import useVoiceInput from "./useVoiceInput";
import { api } from "@/lib/client";
import { waitForJob } from "@/lib/ai/client";
import type { JobView } from "@/lib/ai/types";

type Reply = { id: number; role: "assistant"; text: string; answer?: { short: string; warnings?: string[] } | null };
type Turn = { role: "user" | "assistant"; content: string };
type ChatResponse = { accepted?: boolean; assistant?: Reply; job?: JobView };

/** A device-local, TURN-BASED voice call. Hermes is invoked by the existing authenticated D-AI Gateway as needed.
 * No fake direct audio socket or fake full-duplex claim. STT/TTS are delegated to the v3 Voice Worker / browser fallback.
 */
export default function VoiceCallDialog() {
  const { mood, setMood, voiceOut, setVoiceOut, speak, stopSpeak, speaking } = useApp();
  const [visible, setVisible] = useState(false);
  const [calling, setCalling] = useState(false);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autoListen, setAutoListen] = useState(false);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("Sẵn sàng gọi D-AI Bot.");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [lastJob, setLastJob] = useState<JobView | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const callingRef = useRef(false);
  const mutedRef = useRef(false);
  const heardAudioRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const listenRef = useRef<() => Promise<void>>(async () => {});

  const ask = useCallback(async (question: string, mode: "voice" | "text") => {
    const q = question.trim();
    if (!q || !callingRef.current || busy || abortRef.current) return;
    const controller = new AbortController(); abortRef.current = controller;
    setBusy(true); setMood("thinking"); setDraft(""); setLastJob(null);
    setStatus("Đang hỏi trợ lý AI…");
    setTurns((x) => [...x, { role: "user", content: q }]);
    try {
      const response = await api<ChatResponse>("/api/chat", {
        method: "POST", json: { question: q, inputMode: mode, requestKey: crypto.randomUUID() }, signal: controller.signal,
      });
      let reply = response.assistant;
      if (response.accepted && response.job) {
        setLastJob(response.job);
        const result = await waitForJob<unknown, Reply>(response.job.id, setLastJob, controller.signal);
        reply = result.assistant || undefined;
        if (!reply) throw new Error(result.job.error || "Tác vụ chưa có kết quả. Hãy thử lại.");
      }
      if (!reply) throw new Error("Không nhận được câu trả lời từ D-AI.");
      if (!callingRef.current || controller.signal.aborted) return;
      const text = reply.answer?.short || reply.text;
      setTurns((x) => [...x, { role: "assistant", content: text }]);
      setStatus(voiceOut === "text" ? "Đã trả lời bằng văn bản." : "Đang phát tiếng qua loa thiết bị này.");
      setMood("idle");
      if (voiceOut !== "text") speak(text);
    } catch (e) {
      if (!controller.signal.aborted) {
        setStatus(e instanceof Error ? e.message : "Không thể kết nối trợ lý AI.");
        setMood("error");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }, [busy, setMood, voiceOut, speak]);

  const voice = useVoiceInput({
    busy: busy || !calling || muted,
    onText: setDraft,
    onFinal: (text) => { void ask(text, "voice"); },
    onError: (msg) => { if (msg) setStatus(msg); },
  });
  listenRef.current = voice.start;

  const end = useCallback(() => {
    callingRef.current = false; setCalling(false);
    abortRef.current?.abort(); abortRef.current = null;
    voice.cancel(); stopSpeak();
    setStatus("Đã kết thúc cuộc gọi."); setMood("idle"); setBusy(false);
  }, [voice, stopSpeak, setMood]);

  useEffect(() => {
    const open = () => { setVisible(true); setStatus("Bấm Bắt đầu gọi để trò chuyện bằng tiếng Việt."); };
    window.addEventListener("dai:call", open);
    return () => window.removeEventListener("dai:call", open);
  }, []);
  useEffect(() => { if (visible) listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [turns, visible]);
  useEffect(() => {
    if (speaking) { heardAudioRef.current = true; return; }
    if (!heardAudioRef.current) return;
    heardAudioRef.current = false;
    if (!visible || !calling || muted || !autoListen || busy || voice.listening || voice.transcribing) return;
    const timer = setTimeout(() => { if (callingRef.current && !mutedRef.current) void listenRef.current(); }, 350);
    return () => clearTimeout(timer);
  }, [speaking, visible, calling, muted, autoListen, busy, voice.listening, voice.transcribing]);

  if (!visible) return null;
  const close = () => { end(); setVisible(false); };
  const start = () => { callingRef.current = true; mutedRef.current = false; setMuted(false); setCalling(true); setTurns([]); setStatus("Đã kết nối D-AI. Nói hoặc nhập câu hỏi."); if (autoListen) setTimeout(() => void listenRef.current(), 150); };
  const toggleMic = () => { if (!calling) return; const m = !mutedRef.current; mutedRef.current = m; setMuted(m); if (m) voice.cancel(); else void voice.start(); };
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/90 p-3 backdrop-blur-xl" role="presentation"
      onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
      <section role="dialog" aria-modal="true" aria-label="Cuộc gọi giọng nói D-AI" className="glass flex max-h-[95dvh] w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-cyan-400/25 bg-[#0b162b]">
        <header className="flex items-center gap-3 border-b border-white/10 p-4">
          <Phone className="h-5 w-5 text-emerald-300" />
          <div className="flex-1"><h2 className="font-bold">Gọi D-AI Bot</h2><p className="text-xs text-slate-400">Hội thoại theo lượt với trợ lý AI</p></div>
          <button onClick={close} className="rounded-xl p-2 hover:bg-white/10" aria-label="Đóng cuộc gọi"><X className="h-5 w-5" /></button>
        </header>
        <div className="flex flex-col items-center gap-2 px-4 py-3">
          <Robot mood={calling ? mood : "idle"} size={130} />
          <span className="rounded-full bg-cyan-500/10 px-3 py-1 text-xs text-cyan-100">{status}</span>
          <p className="text-center text-xs text-slate-400">Giọng nói được phát trên thiết bị đang dùng. Micro có thể yêu cầu HTTPS/localhost. Đây chưa phải full-duplex.</p>
        </div>
        <div ref={listRef} className="scroll-thin min-h-[100px] max-h-[27vh] space-y-2 overflow-y-auto px-4 py-2" aria-live="polite">
          {turns.map((t,i) => <div key={i} className={`max-w-[92%] rounded-xl p-2 text-sm ${t.role === "user" ? "ml-auto bg-cyan-600/20 text-cyan-100" : "mr-auto bg-slate-800 text-slate-100"}`}>{t.content}</div>)}
          {lastJob && <p className="text-xs text-amber-200">Tác vụ: {lastJob.state} · {lastJob.progress}%</p>}
        </div>
        <div className="border-t border-white/10 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
            {!calling ? <button className="btn btn-primary" onClick={start}><Phone className="h-4 w-4"/> Bắt đầu gọi</button> : <>
              <button className="btn btn-ghost" disabled={busy || voice.transcribing} onClick={() => { if (voice.listening) voice.stop(); else if (!muted) void voice.start(); }}>
                {voice.listening ? <Square className="h-4 w-4"/> : <Mic className="h-4 w-4"/>} {voice.listening ? "Dừng nghe" : voice.transcribing ? "Đang nhận dạng" : "Nói"}
              </button>
              <button className="btn btn-ghost" onClick={toggleMic}>{muted ? <MicOff className="h-4 w-4 text-rose-300"/> : <Mic className="h-4 w-4"/>}{muted ? "Bật mic" : "Tắt mic"}</button>
              <button className="btn btn-ghost" onClick={() => setVoiceOut(voiceOut === "text" ? "device" : "text")}>{voiceOut === "text" ? <VolumeX className="h-4 w-4"/> : <Volume2 className="h-4 w-4"/>} Loa</button>
              <button className="btn btn-ghost" onClick={() => { stopSpeak(); setStatus("Đã ngắt phát âm thanh."); }}><RotateCcw className="h-4 w-4"/> Ngắt lời</button>
              <button className="btn btn-danger" onClick={end}><PhoneOff className="h-4 w-4"/> Kết thúc</button>
            </>}
          </div>
          <label className="mb-2 flex items-center justify-center gap-2 text-xs text-slate-300"><input type="checkbox" checked={autoListen} onChange={(e) => setAutoListen(e.target.checked)} /> Tự nghe lại sau khi robot nói xong (thử nghiệm)</label>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(draft, "text"); }}>
            <input className="input flex-1" aria-label="Câu hỏi của cuộc gọi" placeholder="Hỏi về camera, ảnh, trí nhớ..." value={draft} maxLength={1000} onChange={(e) => setDraft(e.target.value)} disabled={!calling || busy} />
            <button className="btn btn-primary" type="submit" disabled={!calling || busy || !draft.trim()}><Send className="h-4 w-4"/></button>
          </form>
          <p className="mt-2 text-center text-[11px] text-slate-400">Nguồn nhận lời nói: {voice.source}. Cuộc gọi không tự ghi âm lưu trữ.</p>
        </div>
      </section>
    </div>
  );
}
