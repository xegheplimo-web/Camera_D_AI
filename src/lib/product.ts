/** User-provided product metadata belongs to a particular image/extraction, never to an AI observation. */
export type ProductMeta = { productName: string | null; sku: string | null; priceVnd: number | null; quantity: number | null };
export function parseProductMeta(value: Record<string, unknown>): ProductMeta {
  const cleaned = (key: string, max: number) => {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string" || raw.length > max) throw new Error(`${key}: giá trị không hợp lệ`);
    return raw.trim() || null;
  };
  const numeric = (key: string) => {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw === "boolean" || (typeof raw === "string" && !/^\d+$/.test(raw))) throw new Error(`${key}: phải là số nguyên không âm`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0 || n > 2_000_000_000) throw new Error(`${key}: giá trị phải trong khoảng 0–2 tỷ`);
    return n;
  };
  return { productName: cleaned("productName",120), sku: cleaned("sku",80), priceVnd: numeric("priceVnd"), quantity: numeric("quantity") };
}
