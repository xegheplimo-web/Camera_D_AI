import { authorize } from "@/lib/auth-server";
import { getSettings } from "@/lib/settings";
import { aiProblem, throttle } from "@/lib/ai/http";
import { AiError } from "@/lib/ai/types";
import { boundedJson, serviceFetch } from "@/lib/ai/services";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function POST(req: Request) {
  const auth = await authorize("ask");
  if (auth.response) return auth.response;
  try {
    throttle(`stt:${auth.session.sub}`, 10);
    if (!req.headers.get("content-type")?.includes("multipart/form-data")) throw new AiError("MULTIPART_REQUIRED", "Gửi audio dưới dạng multipart/form-data.", 415);
    const max = 6 * 1024 * 1024;
    // Bound the actual streamed body, not just the client-reported Content-Length.
    const reader = req.body?.getReader();
    if (!reader) throw new AiError("NO_AUDIO", "Chưa có audio.", 400);
    const parts: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max + 4096) { await reader.cancel(); throw new AiError("AUDIO_TOO_LARGE", "Audio tối đa 6 MB.", 413); }
      parts.push(value);
    }
    const data = await new Response(new Uint8Array(Buffer.concat(parts)), { headers: { "Content-Type": req.headers.get("content-type")! } }).formData();
    const file = data.get("file");
    if (!(file instanceof File) || !file.size || file.size > max) throw new AiError("INVALID_AUDIO", "Audio cần là tệp không rỗng, tối đa 6 MB.", 400);
    const bytes = Buffer.from(await file.arrayBuffer());
    const kind = bytes.subarray(0, 4).toString();
    const format = kind === "RIFF" ? "wav" : kind === "OggS" ? "ogg" : bytes[0] === 0x1a && bytes[1] === 0x45 ? "webm" : bytes.subarray(4, 8).toString() === "ftyp" ? "mp4" : kind.startsWith("ID3") || bytes[0] === 0xff ? "mp3" : null;
    if (!format) throw new AiError("UNSUPPORTED_AUDIO", "Không nhận dạng được định dạng âm thanh.", 415);
    const model = process.env.DAI_VOICE_STT_MODEL;
    if (!model) throw new AiError("STT_NOT_CONFIGURED", "Voice Worker chưa có model STT.");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: file.type }), `question.${format}`);
    form.append("model", model); form.append("language", "vi"); form.append("response_format", "json");
    const settings = await getSettings();
    const upstream = await serviceFetch("voice", "audio/transcriptions", { method: "POST", body: form }, { signal: req.signal, allowRemote: settings.remoteProcessingAllowed });
    const response = await boundedJson(upstream);
    if (typeof response.text !== "string") throw new AiError("INVALID_TRANSCRIPT", "Voice Worker chưa trả lời thoại hợp lệ.");
    return Response.json({ text: response.text.slice(0, 1000), source: "voice-worker", language: "vi", storedAudio: false });
  } catch (e) { return aiProblem(e); }
}
