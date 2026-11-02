import { timingSafeEqual } from "node:crypto";
import { dispatchJobs } from "@/lib/ai/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(req: Request) {
  const expected = process.env.DAI_DISPATCH_TOKEN;
  if (!expected || expected.length < 32) return Response.json({ title: "Dispatcher chưa cấu hình", status: 503 }, { status: 503 });
  const token = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(token), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ title: "Không được phép", status: 401 }, { status: 401 });
  const processed = await dispatchJobs();
  return Response.json({ processed, maxConcurrency: 2 });
}
