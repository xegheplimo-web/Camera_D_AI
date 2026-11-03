-- 008_tenants.sql — nền multi-tenant (T-1333)
-- Nguyên tắc: additive, idempotent, KHÔNG phá app đang chạy.
-- Cột tenant_id có DEFAULT = tenant mặc định để insert cũ vẫn chạy; code sẽ truyền tenant_id tường minh ở PR sau.
BEGIN;

CREATE TABLE IF NOT EXISTS tenants (
  id serial PRIMARY KEY,
  slug text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_uniq UNIQUE (slug)
);

INSERT INTO tenants (slug, name)
VALUES ('default', 'Hộ gia đình mặc định')
ON CONFLICT (slug) DO NOTHING;

DO $$
DECLARE
  tid integer;
  t text;
  tables text[] := ARRAY['users','cameras','events','assets','extractions','ai_jobs','messages','alert_rules'];
BEGIN
  SELECT id INTO tid FROM tenants WHERE slug = 'default';
  IF tid IS NULL THEN
    RAISE EXCEPTION 'default tenant missing';
  END IF;

  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id integer REFERENCES tenants(id) ON DELETE RESTRICT', t);
    EXECUTE format('UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL', t) USING tid;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT %s', t, tid);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', t || '_tenant_idx', t);
  END LOOP;
END $$;

COMMIT;
