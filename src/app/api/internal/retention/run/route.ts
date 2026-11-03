import { timingSafeEqual } from "node:crypto";
import { db } from "@/db";
import { runRetention, unlinkPending } from "@/lib/retention";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Chạy retention thủ công/qua scheduler ngoài — token nội bộ như /api/internal/jobs/dispatch. */
export async function POST(req: Request) {
  const expected = process.env.DAI_DISPATCH_TOKEN;
  if (!expected || expected.length < 32) return Response.json({ title: "Retention chưa cấu hình", status: 503 }, { status: 503 });
  const token = req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(token), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return Response.json({ title: "Không được phép", status: 401 }, { status: 401 });
  // Atomic: mọi xoá + audit row commit cùng nhau, hoặc rollback hết.
  const report = await db.transaction(async (tx) => runRetention(tx));
  // Xoá file SAU commit: rollback không được làm mất ảnh còn tham chiếu.
  await unlinkPending(report.pendingFiles);
  return Response.json(report);
}
