-- Data retention: delete activity older than N days (0 = keep forever).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS retention_days int NOT NULL DEFAULT 0;

-- Full branding: admin-configurable primary/accent colours and an optional logo.
-- brand_logo_path stores the logo file path relative to config.dataDir (NULL = no logo).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS brand_primary text NOT NULL DEFAULT '#0d6b63';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS brand_accent text NOT NULL DEFAULT '#f2b544';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS brand_logo_path text NULL;
