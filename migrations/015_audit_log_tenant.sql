-- H-01g: audit_log.tenant_id — đóng lỗ hổng lọc audit theo display_name.
-- Nullable: log legacy/system không quy được tenant; KHÔNG backfill mù.
-- Idempotent: ADD COLUMN/CREATE INDEX IF NOT EXISTS — chạy lại không lỗi.
BEGIN;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS tenant_id integer;
CREATE INDEX IF NOT EXISTS audit_log_tenant_idx ON audit_log (tenant_id, id DESC);
COMMIT;
