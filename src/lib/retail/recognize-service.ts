import sharp from "sharp";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { knowledgeItems } from "@/db/schema";
import { normalizeGtin } from "@/lib/knowledge/normalize";
import { encodeImage } from "./encoder";
import { loadIndex, searchTopK } from "./embedding-store";
import { decide, type Decision } from "./recognize";

/**
 * T-1364 — nhận diện sản phẩm từ ảnh: encode → tìm trong index của tenant →
 * (tuỳ chọn) đối chiếu barcode → quyết định 5 nhánh.
 */

/** Độ nét = phương sai Laplacian trên ảnh xám 128×128. Ảnh mờ/trơn ⇒ rất thấp. */
export async function sharpness(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf).resize(128, 128, { fit: "cover" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const v = -4 * data[i] + data[i - 1] + data[i + 1] + data[i - w] + data[i + w];
      sum += v;
      sumSq += v * v;
      n += 1;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Ngưỡng nét tối thiểu — KHỞI TẠO, chưa hiệu chuẩn trên ảnh thật (T-1363). */
export function minSharpness(): number {
  return Number(process.env.RETAIL_MIN_SHARPNESS ?? 40);
}

/**
 * Tra item theo barcode/GTIN trong catalog của tenant.
 * So khớp trên CHỮ SỐ ĐÃ BỎ SỐ 0 ĐẦU vì cùng một mã có thể được lưu dạng EAN-13
 * (8938505974194) hoặc GTIN-14 (08938505974194) — `normalizeGtin` chuẩn hoá về 14.
 */
export async function itemByBarcode(tenantId: number, barcode: string): Promise<number | null> {
  const gtin = normalizeGtin(barcode);
  if (!gtin) return null;
  const key = gtin.replace(/^0+/, "");
  const [row] = await db
    .select({ id: knowledgeItems.id })
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.tenantId, tenantId),
        isNull(knowledgeItems.mergedIntoId),
        sql`ltrim(regexp_replace(coalesce(${knowledgeItems.custom}->>'gtin',''), '\D', '', 'g'), '0') = ${key}`
      )
    )
    .limit(1);
  return row ? Number(row.id) : null;
}

export type RecognizeInput = {
  tenantId: number;
  buffer: Buffer;
  barcode?: string | null;
};

export type RecognizeResult = Decision & {
  encodeMs: number;
  searchMs: number;
  sharpness: number;
  barcode: string | null;
  barcodeItemId: number | null;
};

export async function recognizeImage(input: RecognizeInput): Promise<RecognizeResult> {
  const sharpVal = await sharpness(input.buffer);
  const usable = sharpVal >= minSharpness();

  const barcode = input.barcode ? normalizeGtin(input.barcode) : null;
  const barcodeItemId = barcode ? await itemByBarcode(input.tenantId, barcode) : null;

  // Ảnh không dùng được: vẫn trả barcode nếu có, nhưng KHÔNG kết luận bằng visual.
  if (!usable) {
    const decision = decide({ hits: [], barcode, barcodeItemId, imageUsable: false });
    return { ...decision, encodeMs: 0, searchMs: 0, sharpness: sharpVal, barcode, barcodeItemId };
  }

  const { vec, ms: encodeMs } = await encodeImage(input.buffer);
  const index = await loadIndex(input.tenantId);
  const t0 = process.hrtime.bigint();
  const { hits, margin } = searchTopK(index, vec, 5);
  const searchMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const decision = decide({
    hits: hits.map((h) => ({ itemId: h.itemId, score: h.score })),
    barcode,
    barcodeItemId,
    imageUsable: true,
  });

  return { ...decision, margin: decision.margin ?? margin, encodeMs, searchMs, sharpness: sharpVal, barcode, barcodeItemId };
}
