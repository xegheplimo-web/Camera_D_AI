import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { productEmbeddings } from "@/db/schema";
import { EMBED_DIM, MODEL_KEY, MODEL_VERSION } from "./encoder";

/**
 * T-1361 — lưu & tìm vector ảnh sản phẩm THEO TENANT.
 *
 * Không dùng pgvector (DB không cài extension): vector lưu `bytea`, đọc ra
 * `Float32Array` rồi cosine brute-force trong JS. Số đo 20.000 SKU × 384d:
 * 5,52 ms/truy vấn, index 29,3 MB — đủ nhanh, không cần đổi hạ tầng.
 */

/** Float32Array → Buffer little-endian (copy để không phụ thuộc alignment). */
export function packVector(vec: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i += 1) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** Buffer (bytea) → Float32Array; pg trả Buffer có thể lệch alignment nên copy. */
export function unpackVector(buf: Buffer): Float32Array {
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readFloatLE(i * 4);
  return out;
}

export type UpsertInput = {
  tenantId: number;
  itemId: number;
  imageId?: number | null;
  vec: Float32Array;
  model?: string;
  version?: string;
};

/** Idempotent theo (tenant, item, image, model, version) — gọi lại thì ghi đè vector. */
export async function upsertEmbedding(input: UpsertInput): Promise<{ id: number; dim: number }> {
  const model = input.model ?? MODEL_KEY;
  const version = input.version ?? MODEL_VERSION;
  const dim = input.vec.length;
  if (dim !== EMBED_DIM) throw new Error(`Vector ${dim} chiều, cần ${EMBED_DIM}.`);
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += input.vec[i] * input.vec[i];
  norm = Math.sqrt(norm) || 1;

  const [row] = await db
    .insert(productEmbeddings)
    .values({
      tenantId: input.tenantId,
      itemId: input.itemId,
      imageId: input.imageId ?? 0,
      model,
      modelVersion: version,
      dim,
      vec: packVector(input.vec),
      norm,
    })
    .onConflictDoUpdate({
      target: [
        productEmbeddings.tenantId,
        productEmbeddings.itemId,
        productEmbeddings.imageId,
        productEmbeddings.model,
        productEmbeddings.modelVersion,
      ],
      set: { vec: packVector(input.vec), norm, dim },
    })
    .returning({ id: productEmbeddings.id });

  return { id: Number(row.id), dim };
}

export type VectorIndex = {
  dim: number;
  itemIds: number[];
  imageIds: (number | null)[];
  matrix: Float32Array; // n × dim, mỗi hàng đã L2-normalize
};

/** Nạp toàn bộ index của MỘT tenant (chỉ vector của tenant đó). */
export async function loadIndex(tenantId: number, model = MODEL_KEY, version = MODEL_VERSION): Promise<VectorIndex> {
  const rows = await db
    .select({
      itemId: productEmbeddings.itemId,
      imageId: productEmbeddings.imageId,
      vec: productEmbeddings.vec,
      dim: productEmbeddings.dim,
    })
    .from(productEmbeddings)
    .where(
      and(
        eq(productEmbeddings.tenantId, tenantId),
        eq(productEmbeddings.model, model),
        eq(productEmbeddings.modelVersion, version)
      )
    );

  const dim = rows.length ? Number(rows[0].dim) : EMBED_DIM;
  const matrix = new Float32Array(rows.length * dim);
  const itemIds: number[] = [];
  const imageIds: (number | null)[] = [];

  rows.forEach((r, i) => {
    const vec = unpackVector(r.vec as Buffer);
    matrix.set(vec.subarray(0, dim), i * dim);
    itemIds.push(Number(r.itemId));
    imageIds.push(Number(r.imageId) || null);
  });

  return { dim, itemIds, imageIds, matrix };
}

export type Hit = { itemId: number; imageId: number | null; score: number; row: number };

/**
 * Top-K cosine trên index. Trả cả `margin` (top1 − top2) vì DINOv2 có nền
 * cosine cao: quyết định khớp phải dựa trên khoảng cách, không chỉ điểm tuyệt đối.
 */
export function searchTopK(
  index: VectorIndex,
  query: Float32Array,
  k = 5
): { hits: Hit[]; margin: number; top1: number | null } {
  const { dim, matrix, itemIds, imageIds } = index;
  const n = itemIds.length;
  if (!n) return { hits: [], margin: 0, top1: null };

  // Mỗi item chỉ giữ ảnh điểm cao nhất (một SKU có nhiều ảnh).
  const bestByItem = new Map<number, Hit>();
  for (let r = 0; r < n; r += 1) {
    let s = 0;
    const off = r * dim;
    for (let d = 0; d < dim; d += 1) s += matrix[off + d] * query[d];
    const itemId = itemIds[r];
    const prev = bestByItem.get(itemId);
    if (!prev || s > prev.score) bestByItem.set(itemId, { itemId, imageId: imageIds[r], score: s, row: r });
  }

  const hits = [...bestByItem.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, k));
  const top1 = hits.length ? hits[0].score : null;
  const top2 = hits.length > 1 ? hits[1].score : null;
  const margin = top1 !== null && top2 !== null ? top1 - top2 : 0;
  return { hits, margin, top1 };
}

export type IndexStats = { vectors: number; items: number; dim: number; bytes: number; model: string; version: string };

export async function indexStats(tenantId: number, model = MODEL_KEY, version = MODEL_VERSION): Promise<IndexStats> {
  const [row] = await db
    .select({
      vectors: sql<number>`count(*)::int`,
      items: sql<number>`count(distinct ${productEmbeddings.itemId})::int`,
      dim: sql<number>`coalesce(max(${productEmbeddings.dim}), 0)::int`,
      bytes: sql<number>`coalesce(sum(length(${productEmbeddings.vec})), 0)::int`,
    })
    .from(productEmbeddings)
    .where(
      and(
        eq(productEmbeddings.tenantId, tenantId),
        eq(productEmbeddings.model, model),
        eq(productEmbeddings.modelVersion, version)
      )
    );
  return {
    vectors: row?.vectors ?? 0,
    items: row?.items ?? 0,
    dim: row?.dim ?? EMBED_DIM,
    bytes: row?.bytes ?? 0,
    model,
    version,
  };
}

export type EmbedStatus = { images: number; embedded: number; ready: boolean };

/** Trạng thái học của một SKU: số ảnh đã gắn / số ảnh đã có vector (T-1362). */
export async function embedStatus(tenantId: number, itemId: number): Promise<EmbedStatus> {
  const res = await db.execute(sql`
    select
      (select count(*)::int from knowledge_images
        where tenant_id = ${tenantId} and item_id = ${itemId} and deleted_at is null) as images,
      (select count(*)::int from product_embeddings
        where tenant_id = ${tenantId} and item_id = ${itemId}) as embedded
  `);
  const row = (res.rows?.[0] ?? { images: 0, embedded: 0 }) as { images: number; embedded: number };
  const images = Number(row.images ?? 0);
  const embedded = Number(row.embedded ?? 0);
  return { images, embedded, ready: embedded > 0 };
}
