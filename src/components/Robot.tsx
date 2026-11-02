"use client";

import type { RobotMood } from "./AppState";

const MOOD_COLOR: Record<RobotMood, string> = {
  idle: "#22d3ee",
  listening: "#a78bfa",
  thinking: "#6685ff",
  speaking: "#22d3ee",
  alert: "#fbbf24",
  offline: "#7c8aa0",
  error: "#fb7185",
};

export const MOOD_LABEL: Record<RobotMood, string> = {
  idle: "Sẵn sàng hỗ trợ",
  listening: "Đang lắng nghe…",
  thinking: "Đang tìm trong trí nhớ…",
  speaking: "Đang trả lời…",
  alert: "Có sự kiện cần xem",
  offline: "Mất kết nối",
  error: "Không xử lý được yêu cầu",
};

export default function Robot({ mood = "idle", size = 180, wave = false, still = false }: { mood?: RobotMood; size?: number; wave?: boolean; still?: boolean }) {
  const c = MOOD_COLOR[mood];
  const uid = `r${size}${mood}`;
  return (
    <div className="relative inline-block select-none" style={{ width: size, height: size * 1.12 }} aria-label={`D-AI Bot: ${MOOD_LABEL[mood]}`} role="img">
      {/* glow */}
      <div
        className={`absolute inset-x-[10%] bottom-[2%] h-[14%] rounded-full blur-xl transition-colors duration-500 ${mood === "listening" ? "anim-pulse-soft" : ""}`}
        style={{ background: c, opacity: 0.35 }}
      />
      {mood === "thinking" && (
        <div className="absolute left-1/2 top-[2%] -translate-x-1/2 anim-spin-slow rounded-full border-2 border-dashed" style={{ width: size * 0.82, height: size * 0.82, borderColor: `${c}88` }} />
      )}
      {mood === "listening" && (
        <>
          <div className="absolute left-1/2 top-[6%] -translate-x-1/2 rounded-full border-2 anim-ring" style={{ width: size * 0.7, height: size * 0.6, borderColor: c }} />
          <div className="absolute left-1/2 top-[6%] -translate-x-1/2 rounded-full border-2 anim-ring [animation-delay:0.6s]" style={{ width: size * 0.7, height: size * 0.6, borderColor: c }} />
        </>
      )}
      <svg viewBox="0 0 200 224" className={`${still ? "" : "anim-float "}relative h-full w-full drop-shadow-[0_10px_25px_rgba(0,0,0,0.5)]`}>
        <defs>
          <linearGradient id={`${uid}-metal`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.55" stopColor="#dfe8f3" />
            <stop offset="1" stopColor="#9fb0c6" />
          </linearGradient>
          <linearGradient id={`${uid}-visor`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0d1530" />
            <stop offset="1" stopColor="#040814" />
          </linearGradient>
          <radialGradient id={`${uid}-shine`} cx="0.3" cy="0.2" r="0.6">
            <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <filter id={`${uid}-glow`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* antenna */}
        <line x1="100" y1="22" x2="100" y2="8" stroke="#b9c7d8" strokeWidth="4" strokeLinecap="round" />
        <circle cx="100" cy="7" r="5" fill={c} filter={`url(#${uid}-glow)`} className={mood === "thinking" || mood === "alert" ? "anim-blink-fast" : ""} />

        {/* body */}
        <ellipse cx="100" cy="214" rx="44" ry="6" fill="#000" opacity="0.35" />
        <rect x="58" y="138" width="84" height="70" rx="30" fill={`url(#${uid}-metal)`} />
        <rect x="76" y="156" width="48" height="30" rx="12" fill="#0b1328" stroke={c} strokeWidth="2" />
        <text x="100" y="177" textAnchor="middle" fontSize="15" fontWeight="800" fill={c} fontFamily="system-ui" filter={`url(#${uid}-glow)`}>AI</text>
        {/* arms */}
        <rect x="38" y="146" width="22" height="44" rx="11" fill={`url(#${uid}-metal)`} />
        <g className={wave ? "anim-wave" : ""} style={{ transformOrigin: "150px 150px" }}>
          <rect x="140" y={wave ? 112 : 146} width="22" height="44" rx="11" fill={`url(#${uid}-metal)`} />
          {wave && <circle cx="151" cy="110" r="10" fill={`url(#${uid}-metal)`} />}
        </g>

        {/* head */}
        <rect x="22" y="22" width="156" height="126" rx="54" fill={`url(#${uid}-metal)`} />
        <rect x="22" y="22" width="156" height="126" rx="54" fill={`url(#${uid}-shine)`} />
        {/* ears */}
        <rect x="10" y="64" width="20" height="44" rx="10" fill="#c9d5e3" />
        <rect x="170" y="64" width="20" height="44" rx="10" fill="#c9d5e3" />
        <rect x="14" y="74" width="8" height="24" rx="4" fill={c} filter={`url(#${uid}-glow)`} className={mood === "listening" ? "anim-pulse-soft" : ""} />
        <rect x="178" y="74" width="8" height="24" rx="4" fill={c} filter={`url(#${uid}-glow)`} className={mood === "listening" ? "anim-pulse-soft" : ""} />
        {/* visor */}
        <rect x="38" y="44" width="124" height="84" rx="36" fill={`url(#${uid}-visor)`} stroke={`${c}55`} strokeWidth="2" />

        {/* eyes */}
        <g filter={`url(#${uid}-glow)`} stroke={c} fill={c}>
          {mood === "idle" && (
            <g className={still ? "" : "anim-blink"} style={{ transformOrigin: "100px 82px" }}>
              <path d="M62 88 Q76 70 90 88" strokeWidth="7" fill="none" strokeLinecap="round" />
              <path d="M110 88 Q124 70 138 88" strokeWidth="7" fill="none" strokeLinecap="round" />
            </g>
          )}
          {mood === "speaking" && (
            <>
              <path d="M62 84 Q76 68 90 84" strokeWidth="7" fill="none" strokeLinecap="round" />
              <path d="M110 84 Q124 68 138 84" strokeWidth="7" fill="none" strokeLinecap="round" />
            </>
          )}
          {mood === "listening" && (
            <g className="anim-blink" style={{ transformOrigin: "100px 82px" }}>
              <ellipse cx="76" cy="82" rx="11" ry="14" stroke="none" />
              <ellipse cx="124" cy="82" rx="11" ry="14" stroke="none" />
              <circle cx="80" cy="77" r="3.5" fill="#fff" stroke="none" />
              <circle cx="128" cy="77" r="3.5" fill="#fff" stroke="none" />
            </g>
          )}
          {mood === "thinking" && (
            <g className="anim-look">
              <rect x="64" y="76" width="24" height="10" rx="5" stroke="none" />
              <rect x="112" y="76" width="24" height="10" rx="5" stroke="none" />
            </g>
          )}
          {mood === "alert" && (
            <>
              <path d="M62 74 L90 84 L62 92 Z" stroke="none" />
              <path d="M138 74 L110 84 L138 92 Z" stroke="none" />
            </>
          )}
          {mood === "offline" && (
            <g stroke="none">
              <rect x="62" y="82" width="24" height="5" rx="2.5" />
              <rect x="114" y="82" width="24" height="5" rx="2.5" />
            </g>
          )}
          {mood === "error" && (
            <g fill="none">
              <path d="M66 74 Q80 80 88 92" strokeWidth="6" strokeLinecap="round" />
              <path d="M134 74 Q120 80 112 92" strokeWidth="6" strokeLinecap="round" />
            </g>
          )}
        </g>
        {/* mouth */}
        {mood === "speaking" ? (
          <g fill={c} filter={`url(#${uid}-glow)`}>
            {[0, 1, 2, 3, 4].map((i) => (
              <rect key={i} x={84 + i * 7} y="100" width="4" height="14" rx="2" className="anim-eq" style={{ animationDelay: `${i * 0.12}s`, transformOrigin: `${86 + i * 7}px 107px` }} />
            ))}
          </g>
        ) : mood === "alert" || mood === "offline" ? (
          <rect x="88" y="106" width="24" height="4" rx="2" fill={c} />
        ) : mood === "error" ? (
          <path d="M90 108 Q100 100 110 108" stroke={c} strokeWidth="4" fill="none" strokeLinecap="round" />
        ) : (
          <path d="M90 104 Q100 112 110 104" stroke={c} strokeWidth="4" fill="none" strokeLinecap="round" filter={`url(#${uid}-glow)`} />
        )}
        {/* cheeks */}
        {(mood === "idle" || mood === "speaking") && (
          <>
            <ellipse cx="56" cy="104" rx="7" ry="4" fill="#ff7aa8" opacity="0.55" />
            <ellipse cx="144" cy="104" rx="7" ry="4" fill="#ff7aa8" opacity="0.55" />
          </>
        )}
      </svg>
    </div>
  );
}
