import { authorize } from "@/lib/auth-server";
import { discoverOnvif, lanProbeRanges } from "@/lib/camera/onvif";
import { audit, problem } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-process scan throttle. UI repeats every 60 seconds; scans are local ONVIF multicast, not subnet brute-force.
let last = 0;
let pending: Promise<Awaited<ReturnType<typeof discoverOnvif>>> | null = null;

export async function POST() {
  const auth = await authorize("manage");
  if (auth.response) return auth.response;
  if (Date.now() - last < 10_000 && !pending) return problem(429, "Vui lòng đợi 10 giây trước khi quét lại");
  last = Date.now();
  try {
    if (!pending) pending = discoverOnvif();
    const rows = await pending;
    await audit("camera.discover", { targetType: "camera", detail: `ONVIF WS-Discovery quét ${lanProbeRanges().join(", ") || "default route"} — ${rows.length} thiết bị` });
    return Response.json({ items: rows, method: "ONVIF WS-Discovery", scannedAt: new Date().toISOString(), notice: "Chỉ phát hiện thiết bị hỗ trợ ONVIF và cho phép discovery trong cùng phân đoạn LAN." }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return problem(503, "Không thể quét ONVIF", "Kiểm tra tường lửa UDP 3702, adapter mạng và quyền truy cập mạng LAN");
  } finally {
    pending = null;
  }
}
