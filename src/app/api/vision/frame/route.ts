import { authorize } from "@/lib/auth-server";
import { getSettings } from "@/lib/settings";
import { aiProblem, readJson, throttle } from "@/lib/ai/http";
import { AiError } from "@/lib/ai/types";
import { imageWorker, prepareImage } from "@/lib/ai/vision-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function POST(req: Request) {
  const auth = await authorize("capture");
  if (auth.response) return auth.response;
  try {
    throttle(`frame:${auth.session.sub}`, 20);
    const body = await readJson(req, 1500 * 1024);
    if (typeof body.image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(body.image))
      throw new AiError("INVALID_FRAME", "Khung hình phải là JPEG/PNG/WebP base64.", 400);
    const raw = Buffer.from(body.image.slice(body.image.indexOf(",") + 1), "base64");
    if (raw.length > 1024 * 1024) throw new AiError("FRAME_TOO_LARGE", "Khung hình xem trước tối đa 1 MB.", 413);
    const image = await prepareImage(raw);
    const settings = await getSettings();
    const result = await imageWorker("vision", {
      note: "Phát hiện người, ô tô, xe máy, xe đạp và đồ vật; trả nhãn tiếng Việt và bounding box cho từng đối tượng nhìn thấy. Không suy đoán danh tính.",
      taskType: "object_count", demoMode: false, asOf: new Date().toISOString(), allowRemote: settings.remoteProcessingAllowed,
    }, `frame:${crypto.randomUUID()}`, req.signal, image);
    const classes: Record<string, string> = { "người": "person", "ô tô": "car", "xe hơi": "car", "xe máy": "motorcycle", "xe đạp": "bicycle", "xe tải": "truck", "xe buýt": "bus" };
    return Response.json({ detections: result.objects.flatMap((o) => (o.boxes ?? []).map((b) => ({
      label: o.label, class: classes[o.label.toLocaleLowerCase("vi-VN")] ?? o.label, score: o.confidence, bbox: b,
    }))), warnings: result.warnings, worker: "Vision AI", persisted: false });
  } catch (e) { return aiProblem(e); }
}
