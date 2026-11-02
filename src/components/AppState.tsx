"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
export type RobotMood = "idle" | "listening" | "thinking" | "speaking" | "alert" | "offline" | "error";
export type VoiceOut = "device" | "text";
type Ctx = {
  mood: RobotMood; setMood: (m: RobotMood) => void;
  voiceOut: VoiceOut; setVoiceOut: (v: VoiceOut) => void; rate: number; setRate: (n: number) => void;
  speak: (text: string) => void; stopSpeak: () => void; speaking: boolean; hasViVoice: boolean;
  voiceNotice: string | null; workerTts: boolean;
};
const AppCtx = createContext<Ctx | null>(null);
export function AppStateProvider({ children }: { children: ReactNode }) {
  const [mood, setMoodState] = useState<RobotMood>("idle");
  const [voiceOut, setVoiceOutState] = useState<VoiceOut>("device");
  const [rate, setRateState] = useState(1);
  const [speaking, setSpeaking] = useState(false);
  const [hasViVoice, setHasViVoice] = useState(false);
  const [workerTts, setWorkerTts] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const moodTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const out = localStorage.getItem("dai_voice_out"); if (out === "device" || out === "text") setVoiceOutState(out);
    const saved = Number(localStorage.getItem("dai_rate")); if (saved >= 0.6 && saved <= 1.6) setRateState(saved);
    const off = () => setMoodState("offline"), on = () => setMoodState((m) => m === "offline" ? "idle" : m);
    window.addEventListener("offline", off); window.addEventListener("online", on);
    if (!navigator.onLine) off();
    const voices = () => setHasViVoice("speechSynthesis" in window && speechSynthesis.getVoices().some((v) => v.lang.toLowerCase().startsWith("vi")));
    voices(); if ("speechSynthesis" in window) speechSynthesis.addEventListener("voiceschanged", voices);
    const config = () => fetch("/api/orchestration", { cache: "no-store" }).then((r) => r.ok ? r.json() : null).then((s) => { if (s) setWorkerTts(!!s.services?.find((v: { name: string; tts?: boolean }) => v.name === "voice")?.tts); }).catch(() => {});
    config(); window.addEventListener("dai:config", config);
    return () => { window.removeEventListener("offline", off); window.removeEventListener("online", on); window.removeEventListener("dai:config", config); if ("speechSynthesis" in window) speechSynthesis.removeEventListener("voiceschanged", voices); };
  }, []);

  const setMood = useCallback((m: RobotMood) => {
    if (moodTimer.current) clearTimeout(moodTimer.current);
    setMoodState(m); if (m === "alert") moodTimer.current = setTimeout(() => setMoodState("idle"), 6000);
  }, []);
  const stopSpeak = useCallback(() => {
    generation.current++; request.current?.abort(); request.current = null;
    audio.current?.pause(); audio.current = null;
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); audioUrl.current = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    setSpeaking(false); setMoodState("idle");
  }, []);
  const setVoiceOut = useCallback((v: VoiceOut) => { if (v === "text") stopSpeak(); setVoiceOutState(v); localStorage.setItem("dai_voice_out", v); }, [stopSpeak]);
  const setRate = useCallback((n: number) => { setRateState(n); localStorage.setItem("dai_rate", String(n)); }, []);

  // A generation token binds playback to this device and the current utterance; cancelled/stale audio never plays.
  const speak = useCallback((text: string) => {
    stopSpeak(); setVoiceNotice(null);
    if (voiceOut === "text") return;
    const own = generation.current;
    const fallback = (reason?: string) => {
      if (generation.current !== own) return;
      if (reason) setVoiceNotice(reason);
      if (!("speechSynthesis" in window)) { setVoiceNotice("Không có đầu ra giọng nói. Câu trả lời vẫn hiển thị đầy đủ bằng chữ."); return; }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "vi-VN"; utterance.rate = rate;
      const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith("vi")); if (voice) utterance.voice = voice;
      utterance.onstart = () => { if (generation.current === own) { setSpeaking(true); setMoodState("speaking"); } };
      utterance.onend = utterance.onerror = () => { if (generation.current === own) { setSpeaking(false); setMoodState("idle"); } };
      speechSynthesis.speak(utterance);
    };
    if (!workerTts) { fallback("Voice Worker chưa cấu hình · dùng giọng đọc của thiết bị này."); return; }
    request.current = new AbortController();
    const signal = request.current.signal;
    setMoodState("thinking");
    void (async () => {
      try {
        const res = await fetch("/api/voice/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 2000), rate }), signal });
        if (!res.ok) throw new Error("Voice Worker unavailable");
        const blob = await res.blob();
        if (signal.aborted || generation.current !== own) return;
        if (blob.size > 12 * 1024 * 1024) throw new Error("Audio too large");
        const url = URL.createObjectURL(blob); audioUrl.current = url;
        const player = new Audio(url); audio.current = player;
        player.onended = () => { if (generation.current === own) { setSpeaking(false); setMoodState("idle"); URL.revokeObjectURL(url); audioUrl.current = null; } };
        player.onerror = () => fallback("Không phát được audio từ worker · chuyển sang giọng thiết bị.");
        await player.play();
        if (generation.current !== own) { player.pause(); return; }
        setVoiceNotice("Âm thanh do AI tạo · chỉ phát trên thiết bị đang hỏi."); setSpeaking(true); setMoodState("speaking");
      } catch { if (!signal.aborted && generation.current === own) fallback("Voice Worker không khả dụng · chuyển sang giọng thiết bị, không phát sang máy khác."); }
    })();
  }, [voiceOut, rate, workerTts, stopSpeak]);
  useEffect(() => () => { generation.current++; request.current?.abort(); audio.current?.pause(); if (audioUrl.current) URL.revokeObjectURL(audioUrl.current); if (moodTimer.current) clearTimeout(moodTimer.current); }, []);
  const value = useMemo(() => ({ mood, setMood, voiceOut, setVoiceOut, rate, setRate, speak, stopSpeak, speaking, hasViVoice, voiceNotice, workerTts }), [mood, setMood, voiceOut, setVoiceOut, rate, setRate, speak, stopSpeak, speaking, hasViVoice, voiceNotice, workerTts]);
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
export function useApp() { const ctx = useContext(AppCtx); if (!ctx) throw new Error("useApp outside provider"); return ctx; }
