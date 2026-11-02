-- User-entered product fields attached to each extraction, not inferred from image AI.
ALTER TABLE extractions ADD COLUMN IF NOT EXISTS product_name text;
ALTER TABLE extractions ADD COLUMN IF NOT EXISTS sku text;
ALTER TABLE extractions ADD COLUMN IF NOT EXISTS price_vnd integer;
ALTER TABLE extractions ADD COLUMN IF NOT EXISTS quantity integer;
