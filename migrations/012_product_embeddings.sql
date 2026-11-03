-- T-1361: embedding sản phẩm theo tenant (D-AI Retail). Additive + idempotent.
CREATE TABLE IF NOT EXISTS model_registry (
  key text PRIMARY KEY,
  version text NOT NULL,
  license text NOT NULL,
  source_url text,
  dim integer NOT NULL,
  sha256 text,
  installed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_embeddings (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id bigint NOT NULL,
  -- 0 = embedding cấp item (không gắn ảnh cụ thể); > 0 = ảnh cụ thể.
  image_id bigint NOT NULL DEFAULT 0,
  model text NOT NULL,
  model_version text NOT NULL,
  dim integer NOT NULL,
  vec bytea NOT NULL,
  norm real NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Chuẩn hoá bản cũ (nếu có) trước khi siết NOT NULL.
UPDATE product_embeddings SET image_id = 0 WHERE image_id IS NULL;
ALTER TABLE product_embeddings ALTER COLUMN image_id SET DEFAULT 0;
ALTER TABLE product_embeddings ALTER COLUMN image_id SET NOT NULL;

DROP INDEX IF EXISTS product_embeddings_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS product_embeddings_uniq
  ON product_embeddings (tenant_id, item_id, image_id, model, model_version);
CREATE INDEX IF NOT EXISTS product_embeddings_tenant_model_idx
  ON product_embeddings (tenant_id, model, model_version);
CREATE INDEX IF NOT EXISTS product_embeddings_item_idx ON product_embeddings (item_id);

-- Consent: ảnh chỉ vào thư viện chung khi chủ cửa hàng bật rõ ràng.
ALTER TABLE knowledge_images ADD COLUMN IF NOT EXISTS share_to_library boolean NOT NULL DEFAULT false;
