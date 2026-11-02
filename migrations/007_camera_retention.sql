-- REAL-003 — vòng đời dữ liệu: retention có hiệu lực.
-- cameras.retention_days: override số ngày giữ events cho riêng camera.
--   NULL (mặc định) = kế thừa app_settings.retentionDays; >0 = giữ riêng N ngày.
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS retention_days integer;

-- ROLLBACK:
-- ALTER TABLE cameras DROP COLUMN IF EXISTS retention_days;
