import { authorize } from "@/lib/auth-server";
import { getSettings } from "@/lib/settings";
import { aiProblem, readJson, throttle } from "@/lib/ai/http";
import { AiError } from "@/lib/ai/types";
import { serviceFetch } from "@/lib/ai/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function POST(req: Request) {
  const auth = await authorize("ask");
  if (auth.response) return auth.response;
  try {
    throttle(`tts:${auth.session.sub}`, 20);
    const b = await readJson(req);
    if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 2000) throw new AiError("INVALID_TEXT", "Giọng đọc cần 1–2.000 ký tự.", 400);
    const model = process.env.DAI_VOICE_TTS_MODEL;
    if (!model) throw new AiError("TTS_NOT_CONFIGURED", "Dịch vụ giọng đọc chưa có model. Dùng giọng thiết bị hoặc chỉ hiện chữ.");
    const settings = await getSettings();
    const upstream = await serviceFetch("voice", "audio/speech", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: b.text, voice: process.env.DAI_VOICE_NAME ?? "alloy", response_format: "mp3", speed: Math.min(1.6, Math.max(0.6, typeof b.rate === "number" ? b.rate : 1)) }) },
      { signal: req.signal, allowRemote: settings.remoteProcessingAllowed });
    const type = upstream.headers.get("content-type") ?? "audio/mpeg";
    if (!type.startsWith("audio/") && !type.includes("octet-stream")) {
      await upstream.body?.cancel();
      throw new AiError("INVALID_AUDIO", "Dịch vụ giọng đọc không trả dữ liệu âm thanh.");
    }
    // Gateway streams audio to THIS authenticated HTTP client. No device-control command is sent.
    return new Response(upstream.body, { headers: { "Content-Type": type, "Cache-Control": "private, no-store", "X-Output-Target": "requester_device", "X-Content-Type-Options": "nosniff" } });
  } catch (e) { return aiProblem(e); }
}
