import { AiError, type JobKind, type Plan, type Roi, type RouteDecision, type ToolName } from "./types";

/** No model call on admission. Known deterministic queries always bypass Hermes. */
export function routeQuestion(question: string): RouteDecision {
  const q = question.toLocaleLowerCase("vi-VN");
  if (/phân tích|bất thường|lập (báo cáo|kế hoạch)|báo cáo (chi tiết|tổng hợp|toàn bộ)|điều tra|nguyên nhân|đối chiếu|phân tích sâu|tóm tắt.*(tuần|tháng|camera)/u.test(q))
    return { path: "orchestrated", reason: "Yêu cầu phân tích nhiều bước; Hermes chọn công cụ, worker thực hiện." };
  if (/bao nhiêu|mấy (giờ|người|khách|xe)|lượt|đầu tiên|gần nhất|cao điểm|^tìm|tìm kiếm|xin chào|^chào|giúp gì|làm được gì|ảnh đã lưu|ghi chú đã lưu|đang có|hiện tại|khi nào/u.test(q))
    return { path: "fast", reason: "Truy vấn dữ liệu có cấu trúc; Gateway → Memory/SQL, không gọi Hermes." };
  return { path: "orchestrated", reason: "Yêu cầu cần diễn giải; kiểm tra bằng chứng trước khi trả lời." };
}

export function requiredTools(kind: JobKind, note = "", taskType = "freeform"): ToolName[] {
  if (kind === "report") return ["memory.summary", "memory.events"];
  const needsOcr = /ocr|plate|table/.test(taskType) || /chữ|văn bản|mã|nhãn|biển số|phiếu|hóa đơn|bảng|giá|đọc/u.test(note.toLowerCase());
  return taskType === "ocr" || taskType === "plate" ? ["ocr.extract"] : needsOcr ? ["vision.extract", "ocr.extract"] : ["vision.extract"];
}

/** Remote plans are data, never executable code / SQL / URLs. Reject unknown tools and arguments. */
export function validatePlan(value: unknown, kind: JobKind): Plan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiError("INVALID_PLAN", "Hermes trả kế hoạch không hợp lệ.");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some((k) => k !== "tools") || !Array.isArray(p.tools) || p.tools.length < 1 || p.tools.length > 4)
    throw new AiError("INVALID_PLAN", "Kế hoạch Hermes chứa trường hoặc số bước không được phép.");
  const allowed: ToolName[] = kind === "report" ? ["memory.summary", "memory.events"] : ["vision.extract", "ocr.extract"];
  if (p.tools.some((t) => typeof t !== "string" || !allowed.includes(t as ToolName)))
    throw new AiError("FORBIDDEN_TOOL", "Gateway từ chối công cụ ngoài danh sách cho phép.");
  return { tools: [...new Set(p.tools as ToolName[])], origin: "hermes" };
}

export function validateRoi(value: unknown): Roi | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new AiError("INVALID_ROI", "Vùng chọn không hợp lệ.", 400);
  const r = value as Record<string, unknown>;
  const vals = [r.x, r.y, r.w, r.h];
  if (vals.some((n) => typeof n !== "number" || !Number.isFinite(n))) throw new AiError("INVALID_ROI", "Tọa độ vùng chọn phải là số hữu hạn.", 400);
  const { x, y, w, h } = r as Roi;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.000001 || y + h > 1.000001)
    throw new AiError("INVALID_ROI", "Vùng chọn phải nằm hoàn toàn trong ảnh.", 400);
  return { x, y, w, h };
}

export function parseObject(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const p: unknown = JSON.parse(cleaned);
    if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  } catch { /* fail closed, never eval */ }
  throw new AiError("INVALID_RESPONSE", "AI Worker không trả JSON đúng hợp đồng. Kết quả chưa được lưu như dữ liệu xác minh.");
}
