-- T-1356: quyết định "giữ riêng" theo cặp, có vân tay định danh.
CREATE TABLE IF NOT EXISTS knowledge_pair_decisions (
  id bigserial PRIMARY KEY,
  tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  min_item_id bigint NOT NULL,
  max_item_id bigint NOT NULL,
  fingerprint text NOT NULL,
  decided_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_pair_decisions_uniq
  ON knowledge_pair_decisions (tenant_id, min_item_id, max_item_id);
