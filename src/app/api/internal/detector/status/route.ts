import { timingSafeEqual } from "node:crypto";
import { detectorStatus } from "@/lib/camera/detector";

export const dynamic = "force-dynamic";

/** Trạng thái detector cho vận hành nội bộ — token giống /api/internal/jobs/dispatch. */
export async function GET(req: Request) {
  const expected = process.env.DAI_DISPATCH_TOKEN;
  if (!expected || expected.length < 32) return Response.json({ title: "Detector chưa cấu hình token", status: 503 }, { status: 503 });
  const token = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(token), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ title: "Không được phép", status: 401 }, { status: 401 });
  return Response.json(await detectorStatus());
}
