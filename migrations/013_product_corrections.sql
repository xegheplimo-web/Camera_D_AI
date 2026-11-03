-- T-1365: sửa nhận diện sai — append-only, có ngữ cảnh điểm số để đánh giá sau này.
CREATE TABLE IF NOT EXISTS product_corrections (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id bigint NOT NULL,              -- SKU ĐÚNG do người dùng chọn
  predicted_item_id bigint,             -- SKU máy đoán (null nếu UNKNOWN)
  image_id bigint,                      -- knowledge_images.id sau khi gắn ảnh
  asset_id integer,
  score real,
  score_second real,
  margin real,
  source text NOT NULL DEFAULT 'user',  -- user | ocr | barcode
  note text,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_corrections_tenant_idx ON product_corrections (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_corrections_item_idx ON product_corrections (tenant_id, item_id);
