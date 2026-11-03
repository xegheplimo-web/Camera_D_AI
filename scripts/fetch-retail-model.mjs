// Tải model nhận diện sản phẩm (DINOv2-small, ONNX int8, 24 MB) về máy chủ.
// Không bundle model vào repo: model là tài sản bên thứ ba (apache-2.0) và
// chỉ cần ở runtime. Chạy: node scripts/fetch-retail-model.mjs
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://huggingface.co/onnx-community/dinov2-small/resolve/main";
const DIR = process.env.RETAIL_MODEL_DIR || join(process.cwd(), "runtime", "models", "dinov2-small");
const FILES = ["onnx/model_quantized.onnx", "preprocessor_config.json"];

mkdirSync(DIR, { recursive: true });
for (const rel of FILES) {
  const out = join(DIR, rel.replace("onnx/", ""));
  if (existsSync(out)) {
    console.log("skip (đã có)", out);
    continue;
  }
  const res = await fetch(`${BASE}/${rel}`);
  if (!res.ok) throw new Error(`Tải ${rel} thất bại: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(out, buf);
  console.log("ok", out, `${(buf.length / 1e6).toFixed(1)} MB`, createHash("sha256").update(buf).digest("hex").slice(0, 16));
}
console.log("RETAIL_MODEL_PATH =", join(DIR, "model_quantized.onnx"));
