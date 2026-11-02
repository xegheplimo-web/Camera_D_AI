-- CAM-G1-001 object-level authorization. Idempotent upgrade for zip (6).
-- Assets/extractions become user-bound resources (see docs/SECURITY_MAP.md scope contract).
ALTER TABLE assets ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id);
ALTER TABLE extractions ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id);

-- Best-effort backfill from the legacy display-name columns. A name that matches
-- zero or more than one user stays NULL; scope resolution treats such rows as
-- owner-only (fail-closed), never as another user's data.
UPDATE assets a SET user_id = u.id FROM users u
  WHERE a.user_id IS NULL AND a.uploaded_by IS NOT NULL AND a.uploaded_by = u.display_name
    AND (SELECT count(*) FROM users u2 WHERE u2.display_name = a.uploaded_by) = 1;
UPDATE extractions e SET user_id = u.id FROM users u
  WHERE e.user_id IS NULL AND e.created_by IS NOT NULL AND e.created_by = u.display_name
    AND (SELECT count(*) FROM users u2 WHERE u2.display_name = e.created_by) = 1;

CREATE INDEX IF NOT EXISTS assets_user_idx ON assets (user_id);
CREATE INDEX IF NOT EXISTS extractions_user_idx ON extractions (user_id);

-- ROLLBACK:
-- DROP INDEX IF EXISTS extractions_user_idx;
-- DROP INDEX IF EXISTS assets_user_idx;
-- ALTER TABLE extractions DROP COLUMN IF EXISTS user_id;
-- ALTER TABLE assets DROP COLUMN IF EXISTS user_id;
