import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

/**
 * T-1361 — encoder ảnh sản phẩm, chạy LOCAL (không gửi ảnh ra ngoài).
 *
 * Model: DINOv2-small (ONNX int8, 24 MB), license apache-2.0 (HF cardData +
 * repo LICENSE). Ảnh 224×224 ⇒ last_hidden_state 1×257×384 ⇒ lấy CLS token
 * (384 chiều) và L2-normalize. Số đo trên máy dev: nạp 155 ms, suy luận 55 ms.
 *
 * Không train, không fine-tune: thêm SKU chỉ là thêm vector.
 */

export const MODEL_KEY = "dinov2-small";
export const MODEL_VERSION = "int8-224";
export const EMBED_DIM = 384;
const SIZE = 224;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export type EncodeResult = { vec: Float32Array; ms: number; dim: number };

export type EncoderStatus = {
  available: boolean;
  path: string;
  model: string;
  version: string;
  dim: number;
  loadMs: number | null;
  error: string | null;
};

export function modelPath(): string {
  return process.env.RETAIL_MODEL_PATH || join(process.cwd(), "runtime", "models", "dinov2-small", "model_quantized.onnx");
}

type OrtModule = typeof import("onnxruntime-node");
type OrtSession = Awaited<ReturnType<OrtModule["InferenceSession"]["create"]>>;

let sessionPromise: Promise<OrtSession> | null = null;
let loadMs: number | null = null;
let lastError: string | null = null;

async function getSession(): Promise<OrtSession> {
  if (!sessionPromise) {
    const path = modelPath();
    if (!existsSync(path)) {
      lastError = `Không thấy model tại ${path}`;
      throw new Error(lastError);
    }
    sessionPromise = (async () => {
      const t0 = Date.now();
      // Nạp động: onnxruntime-node là phụ thuộc nặng (native binary), chỉ cần khi dùng.
      const ort = (await import("onnxruntime-node")) as OrtModule;
      const session = await ort.InferenceSession.create(path, { intraOpNumThreads: 2 });
      loadMs = Date.now() - t0;
      return session;
    })();
    sessionPromise.catch(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

/** Reset cache (test / đổi RETAIL_MODEL_PATH). */
export function resetEncoder(): void {
  sessionPromise = null;
  loadMs = null;
  lastError = null;
}

export async function encoderStatus(): Promise<EncoderStatus> {
  const path = modelPath();
  const base = { path, model: MODEL_KEY, version: MODEL_VERSION, dim: EMBED_DIM, loadMs };
  if (!existsSync(path)) return { ...base, available: false, error: lastError ?? `Không thấy model tại ${path}` };
  try {
    await getSession();
    return { ...base, loadMs, available: true, error: null };
  } catch (e) {
    return { ...base, available: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function toTensor(input: string | Buffer) {
  const pipeline = sharp(input).resize(SIZE, SIZE, { fit: "cover", position: "centre" }).removeAlpha();
  const { data } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const px = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    for (let c = 0; c < 3; c += 1) px[c * SIZE * SIZE + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  return { data: px };
}

/** Chuẩn hoá L2 tại chỗ — cosine = dot product. */
export function l2norm(vec: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < vec.length; i += 1) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i] / n;
  return out;
}

/** CLS token (index 0) của `last_hidden_state` [1, 257, 384]. */
function clsOf(data: Float32Array | Float64Array, dims: readonly number[]): Float32Array {
  const dim = dims[dims.length - 1];
  if (dim !== EMBED_DIM) throw new Error(`Model trả ${dim} chiều, cần ${EMBED_DIM}.`);
  return Float32Array.from(data.subarray(0, dim));
}

export async function encodeImage(input: string | Buffer): Promise<EncodeResult> {
  const session = await getSession();
  const ort = (await import("onnxruntime-node")) as OrtModule;
  const { data } = await toTensor(input);
  const t0 = process.hrtime.bigint();
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", data, [1, 3, SIZE, SIZE]) });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const tensor = out[session.outputNames[0]];
  const vec = l2norm(clsOf(tensor.data as Float32Array, tensor.dims));
  return { vec, ms, dim: vec.length };
}

/** Chữ ký nội dung ảnh — dùng để biết embedding có còn khớp ảnh hay không. */
export function bufferSha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
