/**
 * T-1364 — quyết định nhận diện sản phẩm. Hàm THUẦN, không I/O, để test được
 * toàn bộ bảng quyết định mà không cần model/DB.
 *
 * Vì sao không dùng một ngưỡng cosine duy nhất: DINOv2 có nền cosine rất cao
 * (hai ảnh cùng kiểu đã 0,96–0,98), nên "cos > 0,85" sẽ khớp gần như mọi thứ.
 * Quyết định dựa trên (1) ràng buộc cứng barcode, (2) điểm tuyệt đối, (3) margin
 * top1−top2. Không đủ chắc chắn ⇒ REVIEW_REQUIRED/UNKNOWN, không đoán.
 */

export type DecisionStatus = "MATCHED" | "REVIEW_REQUIRED" | "UNKNOWN";

export type Reason =
  | "BARCODE_MATCH"
  | "BARCODE_CONFLICT"
  | "VISUAL_CONFIDENT"
  | "VISUAL_AMBIGUOUS"
  | "LOW_SCORE"
  | "NO_INDEX"
  | "IMAGE_UNUSABLE";

export type Candidate = { itemId: number; score: number };

export type DecisionInput = {
  hits: Candidate[]; // đã sắp giảm dần theo score
  /** Barcode/OCR đọc được từ ảnh (null nếu không có). */
  barcode?: string | null;
  /** Item mà barcode trỏ tới (đã tra catalog), null nếu không có/không khớp. */
  barcodeItemId?: number | null;
  /** Ảnh có đủ nét để kết luận không. */
  imageUsable?: boolean;
  thresholds?: Partial<Thresholds>;
};

export type Thresholds = { abs: number; margin: number };

/** Giá trị KHỞI TẠO, chưa hiệu chuẩn trên ảnh thật (xem T-1363). */
export const DEFAULT_THRESHOLDS: Thresholds = {
  abs: Number(process.env.RETAIL_T_ABS ?? 0.9),
  margin: Number(process.env.RETAIL_T_MARGIN ?? 0.05),
};

export type Decision = {
  status: DecisionStatus;
  itemId: number | null;
  score: number | null;
  margin: number | null;
  reason: Reason;
  alternatives: Candidate[];
};

function thresholdsOf(t?: Partial<Thresholds>): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...(t ?? {}) };
}

export function decide(input: DecisionInput): Decision {
  const t = thresholdsOf(input.thresholds);
  const hits = input.hits ?? [];
  const top = hits[0] ?? null;
  const second = hits[1] ?? null;
  const margin = top && second ? top.score - second.score : null;
  const alternatives = hits.slice(0, 5);

  const base = {
    itemId: top?.itemId ?? null,
    score: top?.score ?? null,
    margin,
    alternatives,
  };

  if (input.imageUsable === false) {
    return { ...base, status: "UNKNOWN", reason: "IMAGE_UNUSABLE" };
  }

  // 1) Barcode trùng item trong catalog ⇒ barcode thắng visual.
  if (input.barcodeItemId != null) {
    return { ...base, status: "MATCHED", itemId: input.barcodeItemId, reason: "BARCODE_MATCH" };
  }

  // 2) Có barcode nhưng không tra được item nào ⇒ xung đột với visual, không tự chọn.
  if (input.barcode && input.barcode.length > 0) {
    return { ...base, status: "REVIEW_REQUIRED", reason: "BARCODE_CONFLICT" };
  }

  if (!top) return { ...base, status: "UNKNOWN", reason: "NO_INDEX" };

  // 3) Điểm cao + cách biệt rõ ⇒ khớp.
  if (top.score >= t.abs && (margin ?? 1) >= t.margin) {
    return { ...base, status: "MATCHED", reason: "VISUAL_CONFIDENT" };
  }

  // 4) Điểm cao nhưng nhiều SKU giống nhau ⇒ để người xác nhận.
  if (top.score >= t.abs) {
    return { ...base, status: "REVIEW_REQUIRED", reason: "VISUAL_AMBIGUOUS" };
  }

  // 5) Không đủ điểm ⇒ không biết.
  return { ...base, status: "UNKNOWN", reason: "LOW_SCORE" };
}
