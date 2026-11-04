/**
 * P3 — layout "tường camera": mảng tile {cameraId, order} thuần dữ liệu.
 * Pure helpers — dùng được cả phía route (validate khi PUT) lẫn client
 * (drag reorder), không import DB/next.
 */
export type WallTile = { cameraId: number; order: number };
export const WALL_MAX = 16;

/**
 * Chuẩn hoá layout thô: bỏ id không hợp lệ / không thuộc validIds, bỏ trùng,
 * sort theo order, kẹp WALL_MAX và luôn trả order dày 0..n-1.
 * Input méo (null, {}, "x", …) ⇒ [] — không bao giờ ném.
 */
export function normalizeLayout(raw: unknown, validIds: number[]): WallTile[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set(validIds);
  const seen = new Set<number>();
  const picked: { cameraId: number; order: number; pos: number }[] = [];
  raw.forEach((t, pos) => {
    const tile = t as { cameraId?: unknown; order?: unknown } | null;
    const cameraId = Number(tile?.cameraId);
    const o = Number(tile?.order);
    if (!Number.isSafeInteger(cameraId) || cameraId <= 0) return;
    if (!valid.has(cameraId) || seen.has(cameraId)) return;
    seen.add(cameraId);
    // order thiếu/méo ⇒ xếp theo vị trí mảng gốc, tile không bị rơi mất.
    picked.push({ cameraId, order: Number.isFinite(o) ? o : pos, pos });
  });
  picked.sort((a, b) => a.order - b.order || a.pos - b.pos);
  return picked.slice(0, WALL_MAX).map((t, i) => ({ cameraId: t.cameraId, order: i }));
}

/**
 * Dời tile từ slot `from` sang slot `to` rồi đánh lại order dày.
 * Chỉ số ngoài phạm vi (âm, >= length, không nguyên) ⇒ trả layout y nguyên.
 */
export function moveTile(layout: WallTile[], from: number, to: number): WallTile[] {
  if (!Array.isArray(layout)) return [];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= layout.length || to >= layout.length || from === to) {
    return layout;
  }
  const next = layout.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.map((t, i) => ({ ...t, order: i }));
}
