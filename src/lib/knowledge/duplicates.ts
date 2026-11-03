import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeItems } from "@/db/schema";
import type { Identity } from "./normalize";
import { identityKey, toIdentity } from "./normalize";

/**
 * Tìm ỨNG VIÊN trùng sản phẩm (T-1350A). Không ghi, không sửa, không gộp.
 *
 * Quy tắc lấy từ phản biện GPT (2026-11-03): ràng buộc định danh quyết định
 * TRƯỚC, similarity chỉ dùng để xếp hạng ứng viên — không gán xác suất, không
 * auto-merge. Vì vậy module này không có đường code UPDATE/DELETE.
 */

export type DuplicateClass =
  | "EXACT_CANDIDATE" // GTIN trùng + cùng đơn vị bán + không mâu thuẫn
  | "DIFFERENT_VARIANT" // khác biến thể/dung tích/quy cách đã xác minh
  | "LIKELY_DUPLICATE" // không GTIN nhưng khoá định danh chuẩn hoá trùng
  | "REVIEW_REQUIRED" // thiếu dữ liệu hoặc GTIN mâu thuẫn — người dùng phải xem
  | "UNKNOWN";

export type Candidate = {
  id: number;
  title: string;
  priceVnd: number | null;
  class: DuplicateClass;
  score: number;
  reasons: string[];
};

const VARIANT_FIELDS = ["variant", "flavor", "netQuantity", "netUnit", "packCount", "sellingUnit"] as const;

const CLASS_WEIGHT: Record<DuplicateClass, number> = {
  EXACT_CANDIDATE: 1,
  LIKELY_DUPLICATE: 0.8,
  REVIEW_REQUIRED: 0.5,
  DIFFERENT_VARIANT: 0.2,
  UNKNOWN: 0,
};

/** So một cặp định danh đã chuẩn hoá. Không dùng title. */
export function classifyPair(a: Identity, b: Identity): { class: DuplicateClass; reasons: string[] } {
  if (a.gtin && b.gtin) {
    if (a.gtin === b.gtin) {
      if (a.sellingUnit && b.sellingUnit && a.sellingUnit !== b.sellingUnit)
        return { class: "DIFFERENT_VARIANT", reasons: ["gtin_equal_but_selling_unit_differs"] };
      return { class: "EXACT_CANDIDATE", reasons: ["gtin_equal"] };
    }
    // GTIN khác nhau: có thể đổi bao bì/mã — không tự gộp, nhưng phải cho người dùng xem.
    return { class: "REVIEW_REQUIRED", reasons: ["gtin_conflict"] };
  }

  const diffs = VARIANT_FIELDS.filter((f) => a[f] !== null && b[f] !== null && a[f] !== b[f]);
  if (diffs.length) return { class: "DIFFERENT_VARIANT", reasons: diffs.map((f) => `${f}_differs`) };

  const ka = identityKey(a);
  const kb = identityKey(b);
  if (ka !== null && ka === kb) return { class: "LIKELY_DUPLICATE", reasons: ["identity_key_equal"] };

  const missing = VARIANT_FIELDS.filter((f) => a[f] === null || b[f] === null);
  if (missing.length)
    return { class: "REVIEW_REQUIRED", reasons: ["missing_identity_fields", ...missing.slice(0, 3).map((f) => `${f}_missing`)] };

  return { class: "UNKNOWN", reasons: [] };
}

/** Bỏ dấu tiếng Việt + tách token. Dùng cho tìm ứng viên, KHÔNG dùng làm định danh. */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Jaccard trên token — thay pg_trgm (DB này KHÔNG cài extension pg_trgm). */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

function bestOf(list: Candidate[]): DuplicateClass {
  if (!list.length) return "UNKNOWN";
  return list.reduce((acc, c) => (CLASS_WEIGHT[c.class] > CLASS_WEIGHT[acc] ? c.class : acc), list[0].class);
}

/**
 * Ứng viên cho một draft. Chỉ SELECT; giới hạn theo tenant và bỏ item đã xoá.
 * `title` chỉ dùng để lọc thô ứng viên (ILIKE + Jaccard token), KHÔNG dùng làm định danh.
 */
export async function findCandidates(
  tenantId: number,
  draft: Record<string, unknown>,
  opts: { cameraId?: number | null; limit?: number } = {}
): Promise<{ class: DuplicateClass; candidates: Candidate[] }> {
  const title = typeof draft.title === "string" ? draft.title.trim() : "";
  const identity = toIdentity(draft);
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);

  const conds = [eq(knowledgeItems.tenantId, tenantId), isNull(knowledgeItems.deletedAt)];
  if (opts.cameraId) conds.push(eq(knowledgeItems.cameraId, opts.cameraId));

  const matches = [];
  if (identity.gtin) matches.push(sql`${knowledgeItems.custom}->>'gtin' = ${identity.gtin}`);
  if (identity.brand) matches.push(sql`lower(${knowledgeItems.custom}->>'brand') = ${identity.brand}`);
  // 3 token dài nhất để lọc thô; xếp hạng thật tính trong JS (không cần pg_trgm).
  const probe = tokens(title).sort((a, b) => b.length - a.length).slice(0, 3);
  for (const t of probe) matches.push(sql`${knowledgeItems.title} ilike ${"%" + t + "%"}`);
  if (!matches.length) return { class: "UNKNOWN", candidates: [] };

  const rows = await db
    .select({ id: knowledgeItems.id, title: knowledgeItems.title, priceVnd: knowledgeItems.priceVnd, custom: knowledgeItems.custom })
    .from(knowledgeItems)
    .where(and(...conds, or(...matches)))
    .limit(50);

  const candidates: Candidate[] = [];
  for (const r of rows) {
    const other = toIdentity((r.custom ?? {}) as Record<string, unknown>);
    const { class: cls, reasons } = classifyPair(identity, other);
    const sim = titleSimilarity(title, r.title);
    // Ràng buộc định danh (gtin/brand) mà trùng thì không cần title giống.
    const identityHit =
      (identity.gtin !== null && identity.gtin === other.gtin) ||
      (identity.brand !== null && identity.brand === other.brand);
    if (!identityHit && sim < 0.3) continue;
    candidates.push({
      id: r.id,
      title: r.title,
      priceVnd: r.priceVnd,
      class: cls,
      score: Math.round((CLASS_WEIGHT[cls] + Math.min(sim, 1) * 0.2) * 1000) / 1000,
      reasons,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return { class: bestOf(candidates), candidates: candidates.slice(0, limit) };
}
