"use client";

import ChatPanel from "@/components/ChatPanel";
import Robot, { MOOD_LABEL } from "@/components/Robot";
import { useApp, type RobotMood } from "@/components/AppState";
import { ShieldCheck, Database, Volume2 } from "lucide-react";

export default function ChatPage() {
  const { mood, voiceOut, setVoiceOut, rate, setRate, hasViVoice, workerTts, speak } = useApp();
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <ChatPanel />
      <aside className="space-y-4">
        <div className="glass flex flex-col items-center rounded-2xl p-4 text-center">
          <Robot mood={mood} size={170} />
          <div className="mt-2 text-lg font-bold text-gradient">D-AI Bot</div>
          <div className="text-sm text-cyan-300">{MOOD_LABEL[mood]}</div>
          <div className="mt-3 grid w-full grid-cols-5 gap-1">
            {(["idle", "listening", "thinking", "speaking", "alert"] as RobotMood[]).map((m) => (
              <div key={m} className={`flex flex-col items-center rounded-lg p-1 text-[9px] ${m === mood ? "bg-cyan-500/20 text-cyan-200" : "text-slate-400"}`}>
                <Robot mood={m} size={34} />
                {MOOD_LABEL[m].replace("…", "").replace("!", "")}
              </div>
            ))}
          </div>
        </div>

        <div className="glass space-y-3 rounded-2xl p-4">
          <div className="flex items-center gap-2 font-semibold"><Volume2 className="h-4 w-4 text-violet-300" /> Đầu ra giọng nói</div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setVoiceOut("device")} className={`btn ${voiceOut === "device" ? "btn-primary" : "btn-ghost"} text-xs`}>Loa máy này</button>
            <button onClick={() => setVoiceOut("text")} className={`btn ${voiceOut === "text" ? "btn-primary" : "btn-ghost"} text-xs`}>Chỉ hiện chữ</button>
          </div>
          <label className="block text-xs text-slate-400">
            Tốc độ đọc: <b className="text-slate-200">{rate.toFixed(1)}x</b>
            <input type="range" min={0.6} max={1.6} step={0.1} value={rate} onChange={(e) => setRate(Number(e.target.value))} className="mt-1 w-full accent-cyan-400" />
          </label>
          <button onClick={() => speak("Xin chào, mình là D-AI Bot. Đây là giọng đọc thử.")} className="btn btn-ghost w-full text-xs">Nghe thử</button>
          {!workerTts && !hasViVoice && <p className="text-[11px] text-amber-300">Thiết bị chưa có giọng tiếng Việt cài sẵn — trình duyệt sẽ dùng giọng mặc định.</p>}
          <p className="text-[11px] text-slate-400">Âm thanh chỉ phát trên thiết bị đang hỏi. Máy chủ không bao giờ tự phát loa ở thiết bị khác.</p>
        </div>

        <div className="glass space-y-2 rounded-2xl p-4 text-xs text-slate-300">
          <div className="flex items-start gap-2"><Database className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" /> Số liệu được tính bằng truy vấn SQL có kiểm soát trên dữ liệu đã ghi — không để AI đoán số.</div>
          <div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> Mọi câu trả lời kèm bằng chứng hoặc báo “Chưa xác định được” khi thiếu dữ liệu. Micro chỉ bật khi bạn nhấn.</div>
        </div>
      </aside>
    </div>
  );
}
