import { notFound } from "next/navigation";
import { currentSession } from "@/lib/auth-server";
import DuplicateReview from "./DuplicateReview";

export const dynamic = "force-dynamic";

/**
 * T-1351 — trang "Rà soát trùng".
 * Shell đã chặn phiên hết hiệu lực; ở đây chặn thêm khi chưa có phiên để không
 * hiển thị khung rà soát cho khách. Vai trò được đọc phía server để nút thao tác
 * đúng ngay từ lần render đầu (không chờ hydrate).
 */
export default async function DuplicatesPage({
  searchParams,
}: {
  searchParams: Promise<{ cameraId?: string | string[] }>;
}) {
  const session = await currentSession();
  if (!session) notFound();

  const sp = await searchParams;
  const raw = Array.isArray(sp?.cameraId) ? sp.cameraId[0] : sp?.cameraId;
  const n = Number(raw);
  const cameraId = Number.isSafeInteger(n) && n > 0 ? n : null;

  return <DuplicateReview cameraId={cameraId} initialRole={session.role} />;
}
