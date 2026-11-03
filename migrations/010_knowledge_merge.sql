-- T-1355: gộp sản phẩm trùng + hoàn tác 24 h + provenance giá.
-- Additive, idempotent (chạy lại nhiều lần được).

-- 1) Item bị gộp: không xoá, chỉ đánh dấu để hoàn tác.
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS merged_into_id bigint;
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS merged_at timestamptz;
CREATE INDEX IF NOT EXISTS knowledge_items_merged_into_idx ON knowledge_items (merged_into_id);

-- 2) Provenance giá: giá đến từ đâu, đã duyệt chưa, cửa hàng nào.
ALTER TABLE knowledge_price_history ADD COLUMN IF NOT EXISTS price_source text;
ALTER TABLE knowledge_price_history ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';
ALTER TABLE knowledge_price_history ADD COLUMN IF NOT EXISTS store_id integer;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_price_history_approval_chk'
  ) THEN
    ALTER TABLE knowledge_price_history
      ADD CONSTRAINT knowledge_price_history_approval_chk
      CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

-- 3) Nhật ký gộp — payload đủ để hoàn tác, không suy đoán.
CREATE TABLE IF NOT EXISTS knowledge_merge_log (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  source_id bigint NOT NULL,
  target_id bigint NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
CREATE INDEX IF NOT EXISTS knowledge_merge_log_tenant_idx ON knowledge_merge_log (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS knowledge_merge_log_target_idx ON knowledge_merge_log (target_id);
