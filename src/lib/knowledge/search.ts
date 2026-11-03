import { and, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { assets, extractions, knowledgeItems } from "@/db/schema";
import { getSettings } from "@/lib/settings";
import { assetReadScope } from "@/lib/scope";
import type { SessionPayload } from "@/lib/token";

export type SearchFilter = { q: string; cameraId?: number; limit: number };

/** Đoạn trích ngắn quanh vị trí khớp đầu tiên — chuỗi thuần, không tô sáng. */
function snippet(text: string | null | undefined, q: string): string {
  if (!text) return "";
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.slice(0, 160);
  const start = Math.max(0, i - 60);
  const end = Math.min(text.length, i + q.length + 100);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function firstMatch(fields: (string | null | undefined)[], q: string): string {
  const needle = q.toLowerCase();
  return fields.find((f) => f && f.toLowerCase().includes(needle)) ?? "";
}

/**
 * Tìm kiếm trong phạm vi tenant: knowledge_items (title/sku/note) còn hiệu lực
 * và extractions của các asset thuộc asset read-scope của phiên. Kết quả asset
 * lấy tenant/scope từ bản ghi asset (nguồn ủy quyền), không từ extraction.
 */
export async function searchKnowledge(tenantId: number, session: SessionPayload, { q, cameraId, limit }: SearchFilter) {
  if (!q) return { items: [], assets: [] };
  const pat = `%${q}%`;

  const itemConds: SQL[] = [
    eq(knowledgeItems.tenantId, tenantId),
    isNull(knowledgeItems.deletedAt),
    or(ilike(knowledgeItems.title, pat), ilike(knowledgeItems.sku, pat), ilike(knowledgeItems.note, pat))!,
  ];
  if (cameraId !== undefined) itemConds.push(eq(knowledgeItems.cameraId, cameraId));
  const items = await db
    .select({ id: knowledgeItems.id, title: knowledgeItems.title, sku: knowledgeItems.sku, note: knowledgeItems.note, scope: knowledgeItems.scope, cameraId: knowledgeItems.cameraId })
    .from(knowledgeItems).where(and(...itemConds)).orderBy(desc(knowledgeItems.updatedAt), desc(knowledgeItems.id)).limit(limit);

  const settings = await getSettings();
  const scope = assetReadScope(session);
  const exConds: SQL[] = [
    eq(assets.tenantId, tenantId),
    or(
      ilike(extractions.title, pat), ilike(extractions.note, pat),
      ilike(extractions.productName, pat), ilike(extractions.sku, pat),
      sql`${extractions.result}::text ilike ${pat}`,
    )!,
  ];
  if (scope) exConds.push(scope);
  if (cameraId !== undefined) exConds.push(eq(assets.cameraId, cameraId));
  if (!settings.demoMode) exConds.push(sql`${extractions.source} <> 'demo'`);
  const rows = await db
    .select({
      assetId: assets.id, cameraId: assets.cameraId,
      extractionId: extractions.id, title: extractions.title, note: extractions.note,
      productName: extractions.productName, sku: extractions.sku,
      result: extractions.result, status: extractions.status, createdAt: extractions.createdAt,
    })
    .from(extractions).innerJoin(assets, eq(assets.id, extractions.assetId))
    .where(and(...exConds)).orderBy(desc(extractions.createdAt), desc(extractions.id)).limit(limit);

  return {
    items: items.map((i) => ({
      id: i.id, title: i.title, sku: i.sku, scope: i.scope, cameraId: i.cameraId,
      snippet: snippet(firstMatch([i.title, i.sku, i.note], q), q),
    })),
    assets: rows.map((r) => ({
      assetId: r.assetId, extractionId: r.extractionId, cameraId: r.cameraId,
      title: r.title, status: r.status, createdAt: r.createdAt, thumb: `/api/assets/${r.assetId}`,
      snippet: snippet(firstMatch([r.note, r.productName, r.sku, r.title, r.result?.ocrText, r.result?.summary, ...(r.result?.structured?.map((s) => s.value) ?? [])], q), q),
    })),
  };
}
