import { getSettings, saveSetting, type Settings } from "@/lib/settings";
import { authorize } from "@/lib/auth-server";
import { serviceStatus } from "@/lib/ai/services";
import { audit } from "@/lib/audit";
import { aiProblem, readJson } from "@/lib/ai/http";
import { AiError } from "@/lib/ai/types";

export const dynamic = "force-dynamic";
export async function GET() {
  const auth = await authorize("read");
  if (auth.response) return auth.response;
  // Client feature flags only — worker endpoints/models stay inside the owner-only orchestration API.
  const [settings, voice] = await Promise.all([getSettings(), serviceStatus().then((l) => l.find((s) => s.name === "voice"))]);
  const visible = auth.session.role === "owner" ? settings : { ...settings, hermesEnabled: undefined };
  return Response.json({ settings: visible, role: auth.session.role, capabilities: { voiceStt: !!voice?.stt, voiceTts: !!voice?.tts } });
}
export async function PATCH(req: Request) {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  try {
    const body = await readJson(req);
    const keys: (keyof Settings)[] = ["demoMode", "retentionDays", "remotePlayback", "requireVerifiedForAnswers", "hermesEnabled", "remoteProcessingAllowed", "detectEnabled"];
    const changes: [keyof Settings, unknown][] = [];
    for (const key of keys) {
      if (!(key in body)) continue;
      if ((key === "remoteProcessingAllowed" || key === "remotePlayback") && auth.session.role !== "owner") throw new AiError("OWNER_REQUIRED", "Chỉ chủ hệ thống được thay đổi quyền gửi dữ liệu/âm thanh ra ngoài.", 403);
      const value = body[key];
      if (key === "retentionDays") {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 365) throw new AiError("INVALID_VALUE", "Thời gian lưu phải là 1–365 ngày.", 400);
      } else if (typeof value !== "boolean") throw new AiError("INVALID_VALUE", "Cài đặt bật/tắt phải là boolean.", 400);
      changes.push([key, value]);
    }
    if (!changes.length) throw new AiError("NO_CHANGES", "Không có thay đổi hợp lệ.", 400);
    for (const [key, value] of changes) await saveSetting(key, value);
    await audit("settings.update", { targetType: "settings", detail: changes.map(([k, v]) => `${k}=${v}`).join(", ") });
    return Response.json({ ok: true, settings: await getSettings() });
  } catch (e) { return aiProblem(e); }
}
