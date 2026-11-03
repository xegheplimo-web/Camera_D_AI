import { and, asc, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { assets, cameras, knowledgeImages, knowledgeItems, knowledgePriceHistory } from "@/db/schema";
import { HttpError } from "@/lib/http-guard";
import { assetReadScope } from "@/lib/scope";
import type { SessionPayload } from "@/lib/token";
import { asObject, denied } from "./http";
import { IDENTITY_FIELDS, mergeIdentity } from "./normalize";

export const ITEM_SCOPES = ["camera", "location", "workspace"] as const;
const active = () => isNull(knowledgeItems.deletedAt);
const imgActive = () => isNull(knowledgeImages.deletedAt);

function optionalText(v: unknown, max: number, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, "INVALID_FIELD", `${field} phải là chuỗi.`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, "INVALID_FIELD", `${field} tối đa ${max} ký tự.`);
  return t || null;
}

function requiredTitle(v: unknown): string {
  const t = optionalText(v, 200, "title");
  if (!t) throw new HttpError(400, "INVALID_TITLE", "title bắt buộc, tối đa 200 ký tự.");
  return t;
}

/** Tiền là integer VND: không float, không âm, không để client gửi gì cũng được. */
export function parsePrice(v: unknown): number {
  if (typeof v !== "number" && typeof v !== "string") throw new HttpError(400, "INVALID_PRICE", "priceVnd phải là số nguyên ≥ 0 (VND).");
  if (typeof v === "string" && !v.trim()) throw new HttpError(400, "INVALID_PRICE", "priceVnd phải là số nguyên ≥ 0 (VND).");
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new HttpError(400, "INVALID_PRICE", "priceVnd phải là số nguyên ≥ 0 (VND).");
  return n;
}

/** Trường định danh gửi ở top-level body (hoặc lồng trong custom) — T-1353. */
function identityInput(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of IDENTITY_FIELDS) if (f in b) out[f] = b[f];
  return out;
}

function parseCustom(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "INVALID_CUSTOM", "custom phải là object JSON.");
  return v as Record<string, unknown>;
}

export async function cameraInTenant(tenantId: number, cameraId: unknown): Promise<number> {
  const id = Number(cameraId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "INVALID_CAMERA", "cameraId phải là số nguyên dương.");
  const [cam] = await db.select({ id: cameras.id }).from(cameras)
    .where(and(eq(cameras.id, id), eq(cameras.tenantId, tenantId))).limit(1);
  if (!cam) return denied("camera", id);
  return id;
}

/* ---------------- items ---------------- */

export async function listItems(tenantId: number, filter: { scope?: string; cameraId?: number; q?: string }) {
  const conds = [eq(knowledgeItems.tenantId, tenantId), active()];
  if (filter.scope) conds.push(eq(knowledgeItems.scope, filter.scope));
  if (filter.cameraId !== undefined) conds.push(eq(knowledgeItems.cameraId, filter.cameraId));
  if (filter.q) {
    const pat = `%${filter.q}%`;
    conds.push(or(ilike(knowledgeItems.title, pat), ilike(knowledgeItems.sku, pat), ilike(knowledgeItems.note, pat))!);
  }
  return db.select().from(knowledgeItems).where(and(...conds)).orderBy(desc(knowledgeItems.createdAt), desc(knowledgeItems.id)).limit(200);
}

/** Item + ảnh (còn hiệu lực) + lịch sử giá theo thứ tự thời gian. */
export async function getItem(tenantId: number, id: number) {
  const [item] = await db.select().from(knowledgeItems)
    .where(and(eq(knowledgeItems.id, id), eq(knowledgeItems.tenantId, tenantId), active())).limit(1);
  if (!item) return denied("knowledge_item", id);
  const images = await db.select().from(knowledgeImages)
    .where(and(eq(knowledgeImages.itemId, id), eq(knowledgeImages.tenantId, tenantId), imgActive()))
    .orderBy(asc(knowledgeImages.position), asc(knowledgeImages.id));
  const priceHistory = await db.select().from(knowledgePriceHistory)
    .where(and(eq(knowledgePriceHistory.itemId, id), eq(knowledgePriceHistory.tenantId, tenantId)))
    .orderBy(asc(knowledgePriceHistory.id));
  return { ...item, images, priceHistory };
}

export async function createItem(tenantId: number, session: SessionPayload, body: unknown) {
  const b = asObject(body);
  const title = requiredTitle(b.title);
  const scope = b.scope === undefined ? "camera" : String(b.scope);
  if (!(ITEM_SCOPES as readonly string[]).includes(scope))
    throw new HttpError(400, "INVALID_SCOPE", `scope phải là một trong: ${ITEM_SCOPES.join("|")}.`);
  const cameraId = b.cameraId === undefined || b.cameraId === null ? null : await cameraInTenant(tenantId, b.cameraId);
  const sku = optionalText(b.sku, 200, "sku");
  const note = optionalText(b.note, 2000, "note");
  const priceVnd = b.priceVnd === undefined || b.priceVnd === null ? null : parsePrice(b.priceVnd);
  const custom = mergeIdentity(parseCustom(b.custom), identityInput(b)).custom;
  return db.transaction(async (tx) => {
    const [item] = await tx.insert(knowledgeItems).values({ tenantId, scope, cameraId, title, sku, note, priceVnd, custom, createdBy: session.sub }).returning();
    // Giá khởi tạo cũng là một mốc lịch sử — cùng transaction với insert item.
    if (priceVnd !== null) await tx.insert(knowledgePriceHistory).values({ tenantId, itemId: item.id, priceVnd, createdBy: session.sub });
    return item;
  });
}

export async function updateItem(tenantId: number, id: number, body: unknown) {
  const [item] = await db.select({ id: knowledgeItems.id }).from(knowledgeItems)
    .where(and(eq(knowledgeItems.id, id), eq(knowledgeItems.tenantId, tenantId), active())).limit(1);
  if (!item) return denied("knowledge_item", id);
  const b = asObject(body);
  const set: Partial<typeof knowledgeItems.$inferInsert> = {};
  if ("title" in b) set.title = requiredTitle(b.title);
  if ("scope" in b) {
    const scope = String(b.scope);
    if (!(ITEM_SCOPES as readonly string[]).includes(scope))
      throw new HttpError(400, "INVALID_SCOPE", `scope phải là một trong: ${ITEM_SCOPES.join("|")}.`);
    set.scope = scope;
  }
  if ("cameraId" in b) set.cameraId = b.cameraId === null ? null : await cameraInTenant(tenantId, b.cameraId);
  if ("sku" in b) set.sku = optionalText(b.sku, 200, "sku");
  if ("note" in b) set.note = optionalText(b.note, 2000, "note");
  const idIn = identityInput(b);
  if ("custom" in b || Object.keys(idIn).length) {
    const [cur] = await db.select({ custom: knowledgeItems.custom }).from(knowledgeItems)
      .where(and(eq(knowledgeItems.id, id), eq(knowledgeItems.tenantId, tenantId), active())).limit(1);
    const base = "custom" in b ? parseCustom(b.custom) : ((cur?.custom ?? {}) as Record<string, unknown>);
    set.custom = mergeIdentity(base, idIn).custom;
  }
  // price_vnd chỉ đổi qua POST .../price để luôn có history — PATCH không chạm.
  if (!Object.keys(set).length) throw new HttpError(400, "EMPTY_PATCH", "Không có thay đổi hợp lệ.");
  const [row] = await db.update(knowledgeItems).set({ ...set, updatedAt: new Date() })
    .where(and(eq(knowledgeItems.id, id), eq(knowledgeItems.tenantId, tenantId), active())).returning();
  if (!row) return denied("knowledge_item", id);
  return row;
}

export async function deleteItem(tenantId: number, id: number) {
  const [row] = await db.update(knowledgeItems).set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(knowledgeItems.id, id), eq(knowledgeItems.tenantId, tenantId), active())).returning();
  if (!row) return denied("knowledge_item", id);
  return row;
}

/* ---------------- images ---------------- */

/**
 * Gắn asset vào mục. Asset phải ở cùng tenant + nằm trong asset read-scope của caller
 * (own upload | camera-bound | demo) — gắn ảnh người khác ⇒ 404.
 * UNIQUE(item_id, asset_id): gắn lại cùng asset revive hàng đã soft-delete
 * và cập nhật note — không bao giờ làm mất liên kết.
 */
export async function attachImage(tenantId: number, session: SessionPayload, itemId: number, body: unknown) {
  const [item] = await db.select({ id: knowledgeItems.id }).from(knowledgeItems)
    .where(and(eq(knowledgeItems.id, itemId), eq(knowledgeItems.tenantId, tenantId), active())).limit(1);
  if (!item) return denied("knowledge_item", itemId);
  const b = asObject(body);
  const assetId = Number(b.assetId);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) throw new HttpError(400, "INVALID_ASSET", "assetId phải là số nguyên dương.");
  const note = optionalText(b.note, 2000, "note");
  let position = 0;
  if (b.position !== undefined && b.position !== null) {
    position = Number(b.position);
    if (!Number.isSafeInteger(position) || position < 0) throw new HttpError(400, "INVALID_POSITION", "position phải là số nguyên ≥ 0.");
  }
  const scope = assetReadScope(session);
  const [asset] = await db.select({ id: assets.id, kind: assets.kind }).from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.tenantId, tenantId), ...(scope ? [scope] : []))).limit(1);
  if (!asset || asset.kind !== "image") return denied("asset", assetId);
  const [row] = await db.insert(knowledgeImages)
    .values({ tenantId, itemId, assetId, note, position, createdBy: session.sub })
    .onConflictDoUpdate({ target: [knowledgeImages.itemId, knowledgeImages.assetId], set: { note, position, deletedAt: null } })
    .returning();
  return row;
}

export async function updateImage(tenantId: number, imageId: number, body: unknown) {
  const b = asObject(body);
  const set: Partial<typeof knowledgeImages.$inferInsert> = {};
  if ("note" in b) set.note = optionalText(b.note, 2000, "note");
  if ("position" in b) {
    const position = Number(b.position);
    if (!Number.isSafeInteger(position) || position < 0) throw new HttpError(400, "INVALID_POSITION", "position phải là số nguyên ≥ 0.");
    set.position = position;
  }
  if (!Object.keys(set).length) throw new HttpError(400, "EMPTY_PATCH", "Không có thay đổi hợp lệ.");
  const [row] = await db.update(knowledgeImages).set(set)
    .where(and(eq(knowledgeImages.id, imageId), eq(knowledgeImages.tenantId, tenantId), imgActive())).returning();
  if (!row) return denied("knowledge_image", imageId);
  return row;
}

export async function deleteImage(tenantId: number, imageId: number) {
  const [row] = await db.update(knowledgeImages).set({ deletedAt: new Date() })
    .where(and(eq(knowledgeImages.id, imageId), eq(knowledgeImages.tenantId, tenantId), imgActive())).returning();
  if (!row) return denied("knowledge_image", imageId);
  return row;
}

/* ---------------- price ---------------- */

/** Đổi giá: insert history + update items.price_vnd TRONG CÙNG transaction. */
export async function setPrice(tenantId: number, session: SessionPayload, itemId: number, body: unknown) {
  const priceVnd = parsePrice(asObject(body).priceVnd);
  const item = await db.transaction(async (tx) => {
    const [it] = await tx.select().from(knowledgeItems)
      .where(and(eq(knowledgeItems.id, itemId), eq(knowledgeItems.tenantId, tenantId), active())).limit(1);
    if (!it) return null;
    await tx.insert(knowledgePriceHistory).values({ tenantId, itemId, priceVnd, createdBy: session.sub });
    const [row] = await tx.update(knowledgeItems).set({ priceVnd, updatedAt: new Date() })
      .where(eq(knowledgeItems.id, it.id)).returning();
    return row;
  });
  if (!item) return denied("knowledge_item", itemId);
  return item;
}
