import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeImages, knowledgeItems, knowledgePairDecisions } from "@/db/schema";
import type { Identity } from "./normalize";
import { identityFingerprint, toIdentity } from "./normalize";
import { classifyPair, titleSimilarity, type DuplicateClass } from "./duplicates";

/**
 * T-1356 — "Giữ riêng" lưu THEO CẶP, có dấu vân tay định danh.
 *
 * Quy tắc (phản biện GPT 2026-11-03):
 *  - Quyết định gắn với cặp (minItemId, maxItemId) — không "bắc cầu": A~B và
 *    B~C không làm A~C bị ẩn.
 *  - Dấu vân tay tính từ trường ĐỊNH DANH của cả hai; định danh đổi ⇒ quyết
 *    định hết hiệu lực (người dùng phải xem lại), KHÔNG im lặng áp dụng cái cũ.
 *  - Không xoá gì: bảng chỉ ghi quyết định, item vẫn nguyên.
 */

export function pairKey(a: number, b: number): { lo: number; hi: number; key: string } {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return { lo, hi, key: `${lo}:${hi}` };
}

function fingerprintPart(identity: Identity, title: string): string {
  // identityFingerprint gồm TOÀN BỘ trường định danh (kể cả quy cách), nên đổi
  // dung tích/quy cách là quyết định "giữ riêng" hết hiệu lực.
  const k = identityFingerprint(identity);
  return k !== "" ? `k${k}` : `t${title.toLowerCase().normalize("NFC").trim()}`;
}

/** Vân tay của CẶP, thứ tự chuẩn hoá theo id — đổi định danh ⇒ vân tay đổi. */
export function pairFingerprint(
  a: { id: number; title: string; identity: Identity },
  b: { id: number; title: string; identity: Identity }
): string {
  const [lo, hi] = a.id <= b.id ? [a, b] : [b, a];
  const raw = `${lo.id}#${fingerprintPart(lo.identity, lo.title)}|${hi.id}#${fingerprintPart(hi.identity, hi.title)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/** Ghi quyết định "giữ riêng". Idempotent: gọi lại thì cập nhật vân tay. */
export async function keepSeparate(opts: {
  tenantId: number;
  a: { id: number; title: string; identity: Identity };
  b: { id: number; title: string; identity: Identity };
  actor: number | null;
}): Promise<{ key: string; fingerprint: string }> {
  const { tenantId, a, b, actor } = opts;
  if (a.id === b.id) throw new Error("Không thể giữ riêng một mục với chính nó.");
  const { lo, hi, key } = pairKey(a.id, b.id);
  const fingerprint = pairFingerprint(a, b);

  await db
    .insert(knowledgePairDecisions)
    .values({ tenantId, minItemId: lo, maxItemId: hi, fingerprint, decidedBy: actor })
    .onConflictDoUpdate({
      target: [knowledgePairDecisions.tenantId, knowledgePairDecisions.minItemId, knowledgePairDecisions.maxItemId],
      set: { fingerprint, decidedBy: actor, createdAt: new Date() },
    });

  return { key, fingerprint };
}

/** Map "lo:hi" → fingerprint của các cặp đã quyết định trong tenant. */
export async function decidedMap(tenantId: number, itemIds: number[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!itemIds.length) return out;
  const ids = sql.join(itemIds.map((i) => sql`${i}`), sql`, `);
  const rows = await db
    .select({
      lo: knowledgePairDecisions.minItemId,
      hi: knowledgePairDecisions.maxItemId,
      fp: knowledgePairDecisions.fingerprint,
    })
    .from(knowledgePairDecisions)
    .where(
      and(
        eq(knowledgePairDecisions.tenantId, tenantId),
        sql`(${knowledgePairDecisions.minItemId} in (${ids}) or ${knowledgePairDecisions.maxItemId} in (${ids}))`
      )
    );
  for (const r of rows) out.set(`${Number(r.lo)}:${Number(r.hi)}`, r.fp);
  return out;
}

export type PairSide = { id: number; title: string; priceVnd: number | null; identity: Identity; images: number };

export type PairView = {
  key: string;
  class: DuplicateClass;
  similarity: number;
  reasons: string[];
  priceConflict: boolean;
  a: PairSide;
  b: PairSide;
};

export type PairsResult = {
  pairs: PairView[];
  counts: { exact: number; review: number; variantsHidden: number; decidedHidden: number };
};

const VISIBLE: DuplicateClass[] = ["EXACT_CANDIDATE", "LIKELY_DUPLICATE", "REVIEW_REQUIRED"];

/**
 * Liệt kê CẶP trùng trong một camera (hoặc toàn tenant) để UI rà soát.
 * Chỉ đọc; cặp đã "giữ riêng" với vân tay còn hiệu lực bị ẩn.
 */
export async function findDuplicatePairs(
  tenantId: number,
  opts: { cameraId?: number | null; limit?: number } = {}
): Promise<PairsResult> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const conds = [
    eq(knowledgeItems.tenantId, tenantId),
    isNull(knowledgeItems.deletedAt),
    isNull(knowledgeItems.mergedIntoId),
  ];
  if (opts.cameraId) conds.push(eq(knowledgeItems.cameraId, opts.cameraId));

  const rows = await db
    .select({
      id: knowledgeItems.id,
      title: knowledgeItems.title,
      priceVnd: knowledgeItems.priceVnd,
      custom: knowledgeItems.custom,
    })
    .from(knowledgeItems)
    .where(and(...conds))
    .limit(500);

  if (rows.length < 2) return { pairs: [], counts: { exact: 0, review: 0, variantsHidden: 0, decidedHidden: 0 } };

  const items = rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    priceVnd: r.priceVnd,
    identity: toIdentity((r.custom ?? {}) as Record<string, unknown>),
  }));

  const imgRows = await db
    .select({ itemId: knowledgeImages.itemId, c: sql<number>`count(*)::int` })
    .from(knowledgeImages)
    .where(and(eq(knowledgeImages.tenantId, tenantId), isNull(knowledgeImages.deletedAt)))
    .groupBy(knowledgeImages.itemId);
  const imgCount = new Map<number, number>(imgRows.map((r) => [Number(r.itemId), r.c]));

  const decided = await decidedMap(tenantId, items.map((i) => i.id));

  const pairs: PairView[] = [];
  let variantsHidden = 0;
  let decidedHidden = 0;

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      const { class: cls, reasons } = classifyPair(a.identity, b.identity);
      if (cls === "DIFFERENT_VARIANT") {
        variantsHidden += 1;
        continue;
      }
      if (!VISIBLE.includes(cls)) continue;

      const { key } = pairKey(a.id, b.id);
      const fp = decided.get(key);
      if (fp && fp === pairFingerprint(a, b)) {
        decidedHidden += 1;
        continue;
      }

      pairs.push({
        key,
        class: cls,
        similarity: Math.round(titleSimilarity(a.title, b.title) * 100) / 100,
        reasons,
        priceConflict: a.priceVnd !== null && b.priceVnd !== null && a.priceVnd !== b.priceVnd,
        a: { ...a, images: imgCount.get(a.id) ?? 0 },
        b: { ...b, images: imgCount.get(b.id) ?? 0 },
      });
    }
  }

  const weight: Record<string, number> = { EXACT_CANDIDATE: 3, LIKELY_DUPLICATE: 2, REVIEW_REQUIRED: 1 };
  pairs.sort((x, y) => (weight[y.class] ?? 0) - (weight[x.class] ?? 0) || y.similarity - x.similarity);

  return {
    pairs: pairs.slice(0, limit),
    counts: {
      exact: pairs.filter((p) => p.class === "EXACT_CANDIDATE").length,
      review: pairs.filter((p) => p.class !== "EXACT_CANDIDATE").length,
      variantsHidden,
      decidedHidden,
    },
  };
}

/** Đọc lại quyết định của một cặp (dùng cho test/audit). */
export async function decisionOf(tenantId: number, a: number, b: number): Promise<string | null> {
  const { lo, hi } = pairKey(a, b);
  const [row] = await db
    .select({ fp: knowledgePairDecisions.fingerprint })
    .from(knowledgePairDecisions)
    .where(
      and(
        eq(knowledgePairDecisions.tenantId, tenantId),
        eq(knowledgePairDecisions.minItemId, lo),
        eq(knowledgePairDecisions.maxItemId, hi)
      )
    )
    .limit(1);
  return row?.fp ?? null;
}
