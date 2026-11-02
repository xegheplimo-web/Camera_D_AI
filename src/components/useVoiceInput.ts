"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { useApp } from "./AppState";

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start: () => void; stop: () => void; abort: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null };
export default function useVoiceInput(options: { busy: boolean; onText: (t: string) => void; onFinal: (t: string) => void; onError: (s: string | null) => void }) {
  const { setMood, stopSpeak } = useApp();
  const callbacks = useRef(options); callbacks.current = options;
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [supported, setSupported] = useState(false);
  const [workerStt, setWorkerStt] = useState(false);
  const [levels, setLevels] = useState<number[]>(Array(24).fill(0.08));
  const token = useRef(0);
  const active = useRef(false);
  const stopRequested = useRef(false);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const raf = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const request = useRef<AbortController | null>(null);
  const text = useRef("");

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    setSupported(!!(w.SpeechRecognition || w.webkitSpeechRecognition));
    api<{ capabilities?: { voiceStt?: boolean } }>("/api/settings").then((s) => {
      const available = !!s.capabilities?.voiceStt;
      setWorkerStt(available);
      if (available && typeof MediaRecorder !== "undefined" && typeof navigator.mediaDevices !== "undefined") setSupported(true);
    }).catch(() => {});
  }, []);

  const cleanup = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null;
    audioCtx.current?.close().catch(() => {}); audioCtx.current = null;
    setLevels(Array(24).fill(0.08));
  }, []);
  const cancel = useCallback(() => {
    token.current++; active.current = false; stopRequested.current = false;
    request.current?.abort(); recognition.current?.abort();
    if (recorder.current?.state === "recording") recorder.current.stop();
    cleanup(); setListening(false); setTranscribing(false); setMood("idle");
  }, [cleanup, setMood]);
  const stop = useCallback(() => {
    stopRequested.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
    recognition.current?.stop();
  }, []);

  const meter = (s: MediaStream) => {
    try {
      const ctx = new AudioContext(); audioCtx.current = ctx;
      const analyser = ctx.createAnalyser(); analyser.fftSize = 64;
      ctx.createMediaStreamSource(s).connect(analyser);
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      const update = () => { analyser.getByteFrequencyData(buffer); setLevels(Array.from(buffer.slice(0, 24)).map((v) => Math.max(0.08, v / 255))); raf.current = requestAnimationFrame(update); };
      raf.current = requestAnimationFrame(update);
    } catch { /* visual meter optional; audio still works */ }
  };

  const start = useCallback(async () => {
    if (callbacks.current.busy || active.current || transcribing) return;
    stopSpeak(); callbacks.current.onError(null);
    const own = ++token.current;
    active.current = true; stopRequested.current = false; text.current = "";
    setListening(true); setMood("listening");
    const done = (transcript: string) => {
      if (token.current !== own) return;
      active.current = false; setListening(false); setTranscribing(false); cleanup();
      const clean = transcript.trim().slice(0, 1000);
      if (clean) { callbacks.current.onText(clean); callbacks.current.onFinal(clean); }
      else { setMood("idle"); callbacks.current.onError("Chưa nghe rõ lời nói. Bạn có thể thử lại hoặc nhập văn bản."); }
    };
    try {
      if (workerStt) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (token.current !== own) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s; meter(s);
        const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
        const rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
        recorder.current = rec;
        const chunks: Blob[] = []; let size = 0;
        rec.ondataavailable = (e) => { if (e.data.size) { size += e.data.size; chunks.push(e.data); if (size > 6 * 1024 * 1024 && rec.state === "recording") rec.stop(); } };
        rec.onstop = async () => {
          if (token.current !== own) return;
          cleanup(); setListening(false); setTranscribing(true); setMood("thinking");
          try {
            const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
            if (blob.size > 6 * 1024 * 1024) throw new Error("Audio vượt giới hạn 6 MB.");
            const form = new FormData(); form.append("file", blob, blob.type.includes("mp4") ? "question.mp4" : "question.webm");
            request.current = new AbortController();
            const result = await api<{ text: string }>("/api/voice/transcriptions", { method: "POST", body: form, signal: request.current.signal });
            done(result.text);
          } catch (e) {
            if (token.current !== own) return;
            active.current = false; setTranscribing(false); setMood("error");
            callbacks.current.onError(e instanceof Error ? e.message : "Voice Worker không nhận được lời nói.");
          }
        };
        rec.start(250);
        timer.current = setTimeout(stop, 30000);
        if (stopRequested.current) rec.stop();
      } else {
        const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
        const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
        if (!Ctor) throw new Error("Chưa có Voice Worker STT và trình duyệt không hỗ trợ nhận giọng nói. Hãy nhập văn bản.");
        const sr = new Ctor(); recognition.current = sr;
        sr.lang = "vi-VN"; sr.interimResults = true; sr.continuous = true;
        sr.onresult = (event) => { if (token.current !== own) return; text.current = Array.from(event.results).map((r) => r[0].transcript).join(" ").trim(); callbacks.current.onText(text.current); };
        sr.onerror = (event) => {
          if (token.current !== own) return;
          if (event.error !== "aborted" && event.error !== "no-speech") callbacks.current.onError(event.error === "not-allowed" ? "Micro bị từ chối quyền. Hãy cấp quyền trong trình duyệt." : `Nhận giọng nói bị gián đoạn: ${event.error}`);
        };
        sr.onend = () => done(text.current);
        sr.start(); timer.current = setTimeout(stop, 30000);
      }
    } catch (e) {
      if (token.current !== own) return;
      active.current = false; cleanup(); setListening(false); setTranscribing(false); setMood("error");
      callbacks.current.onError(e instanceof Error ? e.message : "Không mở được micro.");
    }
  }, [workerStt, transcribing, stopSpeak, setMood, cleanup, stop]);

  useEffect(() => () => { token.current++; request.current?.abort(); recognition.current?.abort(); if (recorder.current?.state === "recording") recorder.current.stop(); cleanup(); }, [cleanup]);
  return { listening, transcribing, supported, levels, start, stop, cancel, source: workerStt ? "Voice Worker · tiếng Việt" : "Dự phòng: Web Speech của trình duyệt" };
}
