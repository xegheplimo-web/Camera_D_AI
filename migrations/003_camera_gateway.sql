-- Run ONLY after DB schema backup. Idempotent upgrade for zip (3).
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS source_ciphertext text;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS source_host text;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS stream_name text;
