-- 009_camera_settings_knowledge.sql — T-1335 Phase 1: cài đặt theo camera + danh mục tri thức.
-- Nguyên tắc: additive, idempotent (chạy lại không lỗi), KHÔNG đổi bảng hiện có.
-- Mọi bảng mới đều có tenant_id REFERENCES tenants(id) — cùng mô hình T-1333.
BEGIN;

-- ===== camera_settings: một hàng/camera, revision chống ghi đè lạc hậu =====
CREATE TABLE IF NOT EXISTS camera_settings (
  camera_id      integer PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  profile        text NOT NULL DEFAULT 'custom',           -- family|shop|warehouse|parking|factory|custom
  features       jsonb NOT NULL DEFAULT '{}',
  record_enabled boolean NOT NULL DEFAULT false,
  record_audio   boolean NOT NULL DEFAULT false,
  retention_days integer NOT NULL DEFAULT 7,
  detect_fps     integer NOT NULL DEFAULT 5,
  zones          jsonb NOT NULL DEFAULT '[]',
  count_lines    jsonb NOT NULL DEFAULT '[]',
  privacy_masks  jsonb NOT NULL DEFAULT '[]',
  notify_enabled boolean NOT NULL DEFAULT false,
  revision       integer NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Fallback khi bảng đã tồn tại nhưng thiếu cột (idempotent).
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS tenant_id integer;
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS profile text NOT NULL DEFAULT 'custom';
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}';
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS record_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS record_audio boolean NOT NULL DEFAULT false;
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS retention_days integer NOT NULL DEFAULT 7;
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS detect_fps integer NOT NULL DEFAULT 5;
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS zones jsonb NOT NULL DEFAULT '[]';
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS count_lines jsonb NOT NULL DEFAULT '[]';
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS privacy_masks jsonb NOT NULL DEFAULT '[]';
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS notify_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE camera_settings ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE camera_settings s SET tenant_id = c.tenant_id FROM cameras c
  WHERE s.camera_id = c.id AND s.tenant_id IS NULL;
ALTER TABLE camera_settings ALTER COLUMN tenant_id SET NOT NULL;

-- ===== knowledge_items: danh mục tri thức/sản phẩm, soft delete =====
CREATE TABLE IF NOT EXISTS knowledge_items (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  scope       text NOT NULL DEFAULT 'camera',
  camera_id   integer REFERENCES cameras(id) ON DELETE SET NULL,
  title       text NOT NULL,
  sku         text,
  note        text,
  price_vnd   integer,
  currency    text NOT NULL DEFAULT 'VND',
  custom      jsonb NOT NULL DEFAULT '{}',
  created_by  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT knowledge_items_scope_chk CHECK (scope IN ('camera','location','workspace'))
);

ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS tenant_id integer;
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'camera';
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS camera_id integer;
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS sku text;
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS price_vnd integer;
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'VND';
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS created_by integer;
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE knowledge_items ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE knowledge_items ALTER COLUMN tenant_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_items_scope_chk') THEN
    ALTER TABLE knowledge_items ADD CONSTRAINT knowledge_items_scope_chk CHECK (scope IN ('camera','location','workspace'));
  END IF;
END $$;

-- ===== knowledge_images: nhiều ảnh/mục, mỗi ảnh một ghi chú riêng =====
-- Cùng asset_id ở NHIỀU item là hợp lệ; UNIQUE chỉ chặn trùng trong cùng một item.
CREATE TABLE IF NOT EXISTS knowledge_images (
  id          bigserial PRIMARY KEY,
  tenant_id   integer NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id     bigint NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  asset_id    integer NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  note        text,
  position    integer NOT NULL DEFAULT 0,
  created_by  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

ALTER TABLE knowledge_images ADD COLUMN IF NOT EXISTS tenant_id integer;
ALTER TABLE knowledge_images ADD COLUMN IF NOT EXISTS item_id bigint;
ALTER TABLE knowledge_images ADD COLUMN IF NOT EXISTS asset_id integer;
ALTER TABLE knowledge_images ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE knowledge_images ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
ALTER TABLE knowledge_images ADD COLUMN IF NOT EXISTS created_by integer;
ALTER TABLE knowledge_images ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE knowledge_images ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE knowledge_images ALTER COLUMN tenant_id SET NOT NULL;

-- ===== knowledge_price_history: mọi thay đổi giá đều lưu vết =====
CREATE TABLE IF NOT EXISTS knowledge_price_history (
  id             bigserial PRIMARY KEY,
  tenant_id      integer NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  item_id        bigint NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  price_vnd      integer NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by     integer REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE knowledge_price_history ADD COLUMN IF NOT EXISTS tenant_id integer;
ALTER TABLE knowledge_price_history ADD COLUMN IF NOT EXISTS item_id bigint;
ALTER TABLE knowledge_price_history ADD COLUMN IF NOT EXISTS price_vnd integer;
ALTER TABLE knowledge_price_history ADD COLUMN IF NOT EXISTS effective_from timestamptz NOT NULL DEFAULT now();
ALTER TABLE knowledge_price_history ADD COLUMN IF NOT EXISTS created_by integer;
ALTER TABLE knowledge_price_history ALTER COLUMN tenant_id SET NOT NULL;

-- ===== Index theo card + index FK phục vụ cascade/lookup =====
CREATE INDEX IF NOT EXISTS knowledge_items_tenant_deleted_idx ON knowledge_items (tenant_id, deleted_at);
CREATE INDEX IF NOT EXISTS knowledge_items_tenant_camera_idx ON knowledge_items (tenant_id, camera_id);
CREATE INDEX IF NOT EXISTS knowledge_images_item_idx ON knowledge_images (item_id);
CREATE INDEX IF NOT EXISTS knowledge_images_asset_idx ON knowledge_images (asset_id);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_images_item_asset_uniq ON knowledge_images (item_id, asset_id);
CREATE INDEX IF NOT EXISTS knowledge_price_history_item_idx ON knowledge_price_history (item_id);

-- ===== Backfill: mọi camera hiện có nhận bộ cài đặt mặc định =====
INSERT INTO camera_settings (camera_id, tenant_id)
SELECT c.id, c.tenant_id FROM cameras c
WHERE NOT EXISTS (SELECT 1 FROM camera_settings s WHERE s.camera_id = c.id);

COMMIT;

-- ROLLBACK:
-- DROP TABLE IF EXISTS knowledge_price_history;
-- DROP TABLE IF EXISTS knowledge_images;
-- DROP TABLE IF EXISTS knowledge_items;
-- DROP TABLE IF EXISTS camera_settings;
