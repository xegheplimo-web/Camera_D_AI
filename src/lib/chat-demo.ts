import type { AnswerPayload } from "@/db/schema";

export const DEMO_WARNING_RE = /dữ liệu mẫu|demo/i;

/**
 * Câu trả lời dựa trên dữ liệu mẫu? Cờ `basedOnDemo` được lưu lúc trả lời;
 * tin nhắn cũ chưa có cờ được nhận diện qua cảnh báo "dữ liệu mẫu" đi kèm.
 */
export function answerBasedOnDemo(a: (Pick<AnswerPayload, "warnings"> & { basedOnDemo?: boolean }) | null | undefined): boolean {
  if (!a) return false;
  return Boolean(a.basedOnDemo) || (a.warnings ?? []).some((w) => DEMO_WARNING_RE.test(w));
}
