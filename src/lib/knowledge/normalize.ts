import { createHash } from "node:crypto";

/**
 * Chuẩn hoá định danh SKU (T-1353).
 *
 * Nguyên tắc: KHÔNG dùng title đã bỏ dấu làm định danh. Title chỉ dùng để tìm
 * ứng viên; định danh dựa trên trường có cấu trúc (GTIN, brand, variant, quy cách).
 * Lý do: "nước mắm cá cơm" và "nước mắm cá hồi" sau khi bỏ dấu gần như trùng nhau.
 */

export const IDENTITY_FIELDS = [
  "gtin",
  "brand",
  "productLine",
  "variant",
  "flavor",
  "netQuantity",
  "netUnit",
  "packCount",
  "sellingUnit",
  "internalSku",
] as const;

export type IdentityField = (typeof IDENTITY_FIELDS)[number];

export const NET_UNITS = ["ml", "g"] as const; // quy đổi hết về ml/g
export const SELLING_UNITS = ["chai", "lon", "hộp", "gói", "lốc", "thùng", "kg", "cái"] as const;

export type Identity = {
  gtin: string | null;
  brand: string | null;
  productLine: string | null;
  variant: string | null;
  flavor: string | null;
  netQuantity: number | null; // luôn quy về ml hoặc g
  netUnit: "ml" | "g" | null;
  packCount: number | null;
  sellingUnit: string | null;
  internalSku: string | null;
};

export const EMPTY_IDENTITY: Identity = {
  gtin: null,
  brand: null,
  productLine: null,
  variant: null,
  flavor: null,
  netQuantity: null,
  netUnit: null,
  packCount: null,
  sellingUnit: null,
  internalSku: null,
};

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.toLowerCase() : null;
}

/** "0,5 l" / "500ml" / "1.5 L" → {value: 500, unit: "ml"} */
export function parseQuantity(input: unknown): { value: number; unit: "ml" | "g" } | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*(ml|l|g|kg|gam|gram)$/);
  if (!m) return null;
  const value = Number(m[1].replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = m[2];
  if (unit === "l") return { value: Math.round(value * 1000), unit: "ml" };
  if (unit === "ml") return { value: Math.round(value), unit: "ml" };
  if (unit === "kg") return { value: Math.round(value * 1000), unit: "g" };
  return { value: Math.round(value), unit: "g" }; // g | gam | gram
}

const CONTAINER_UNITS = new Set(["lốc", "thùng", "hộp", "gói"]);

/**
 * "lốc 6 chai" / "6x330ml" / "thùng 24 lon" → {packCount, sellingUnit}.
 * Đơn vị BÁN là đơn vị xuất hiện sớm nhất trong chuỗi ("lốc 6 chai" ⇒ lốc),
 * không phải đơn vị đầu tiên trong danh sách whitelist.
 */
export function parsePack(input: unknown): { packCount: number | null; sellingUnit: string | null } {
  if (typeof input !== "string") return { packCount: null, sellingUnit: null };
  const s = input.trim().toLowerCase();

  let best: { unit: string; idx: number } | null = null;
  for (const unit of SELLING_UNITS) {
    const idx = s.search(new RegExp(`\\b${unit}\\b`));
    if (idx < 0) continue;
    const better =
      !best ||
      idx < best.idx ||
      (idx === best.idx && CONTAINER_UNITS.has(unit) && !CONTAINER_UNITS.has(best.unit));
    if (better) best = { unit, idx };
  }

  const m = s.match(/(\d+)\s*(?:x|×|nhân)\s*\d/) ?? s.match(new RegExp(`(\\d+)\\s*(?:${SELLING_UNITS.join("|")})`));
  const n = m ? Number(m[1]) : null;
  return {
    packCount: Number.isSafeInteger(n) && (n as number) > 1 ? n : null,
    sellingUnit: best ? best.unit : null,
  };
}

/** GTIN-8/12/13/14: chỉ chữ số, checksum đúng; chuẩn hoá về GTIN-14 (pad 0). */
export function normalizeGtin(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return null;
  if (!gtinChecksumOk(digits)) return null;
  return digits.padStart(14, "0");
}

export function gtinChecksumOk(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  const body = digits.slice(0, -1).split("").reverse();
  const check = Number(digits.slice(-1));
  const sum = body.reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Chuẩn hoá một object thô (body API hoặc custom cũ) thành Identity. */
export function toIdentity(raw: Record<string, unknown>): Identity {
  const qty =
    typeof raw.netQuantity === "number" && (raw.netUnit === "ml" || raw.netUnit === "g")
      ? { value: raw.netQuantity, unit: raw.netUnit as "ml" | "g" }
      : parseQuantity(raw.netQuantity);

  const pack =
    Number.isSafeInteger(raw.packCount) && (raw.packCount as number) > 1
      ? { packCount: raw.packCount as number, sellingUnit: text(raw.sellingUnit) }
      : { packCount: null, sellingUnit: text(raw.sellingUnit) };

  const selling = pack.sellingUnit && (SELLING_UNITS as readonly string[]).includes(pack.sellingUnit)
    ? pack.sellingUnit
    : null;

  return {
    gtin: normalizeGtin(raw.gtin),
    brand: text(raw.brand),
    productLine: text(raw.productLine),
    variant: text(raw.variant),
    flavor: text(raw.flavor),
    netQuantity: qty ? qty.value : null,
    netUnit: qty ? qty.unit : null,
    packCount: pack.packCount,
    sellingUnit: selling,
    internalSku: text(raw.internalSku),
  };
}

/**
 * Khoá dùng để TÌM ứng viên trùng (không phải định danh tuyệt đối).
 * Trả null khi thiếu brand và GTIN — khi đó chỉ còn GTIN/title để so, không đủ tin.
 */
export function identityKey(id: Identity): string | null {
  if (id.gtin) return `gtin:${id.gtin}`;
  if (!id.brand) return null;
  return [
    id.brand,
    id.productLine ?? "",
    id.flavor ?? "",
    id.netQuantity ?? "",
    id.netUnit ?? "",
    id.packCount ?? "",
    id.sellingUnit ?? "",
  ].join("|");
}

/** Vân tay định danh: dùng để biết quyết định "giữ riêng" còn hiệu lực hay không. */
export function identityFingerprint(id: Identity): string {
  const parts = [
    id.gtin ?? "",
    id.brand ?? "",
    id.productLine ?? "",
    id.variant ?? "",
    id.flavor ?? "",
    id.netQuantity ?? "",
    id.netUnit ?? "",
    id.packCount ?? "",
    id.sellingUnit ?? "",
    id.internalSku ?? "",
  ];
  return createHash("sha256").update(parts.join("\u0001")).digest("hex");
}

/**
 * Gộp trường định danh mới vào `custom` hiện có.
 * `identityRevision` chỉ tăng khi vân tay đổi ⇒ quyết định dismiss cũ hết hiệu lực.
 */
export function mergeIdentity(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>
): { custom: Record<string, unknown>; changed: boolean; identity: Identity } {
  const before = toIdentity(current);
  const merged: Record<string, unknown> = { ...current };
  for (const f of IDENTITY_FIELDS) {
    if (incoming[f] === undefined) continue;
    merged[f] = incoming[f] === null ? null : incoming[f];
  }
  const after = toIdentity(merged);
  const changed = identityFingerprint(before) !== identityFingerprint(after);
  const rev = Number.isSafeInteger(current.identityRevision) ? (current.identityRevision as number) : 0;
  merged.identityRevision = changed ? rev + 1 : rev;
  merged.identityFingerprint = identityFingerprint(after);
  return { custom: merged, changed, identity: after };
}
