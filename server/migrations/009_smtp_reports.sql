-- Configurable SMTP (replaces env-only delivery). Stored on the singleton
-- settings row. smtp_pass is a secret and is NEVER exposed through the generic
-- /api/settings endpoint; it is only writable via the dedicated /api/smtp route.
-- smtp_secure: 'none' (plain 25) | 'starttls' (STARTTLS, typically 587) | 'tls'
-- (implicit TLS, typically 465).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_host text NULL;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_port int NULL;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_secure text NOT NULL DEFAULT 'starttls';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_user text NULL;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_pass text NULL;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_from text NULL;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS smtp_reject_unauthorized boolean NOT NULL DEFAULT true;

-- Scheduled daily / weekly email reports. These are not secret and are read/written
-- through the normal /api/settings patch.
-- report_schedule: 'off' | 'daily' | 'weekly'
-- report_hour:     0..23 local hour (per report_tz_offset_min) at/after which a report is due
-- report_weekday:  0=Sun..6=Sat (used for weekly)
-- report_tz_offset_min: JS getTimezoneOffset() convention (UTC minus local, minutes)
ALTER TABLE settings ADD COLUMN IF NOT EXISTS report_schedule text NOT NULL DEFAULT 'off';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS report_hour int NOT NULL DEFAULT 8;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS report_weekday int NOT NULL DEFAULT 1;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS report_recipients text NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN IF NOT EXISTS report_tz_offset_min int NOT NULL DEFAULT 0;

-- One row per sent period so a report is sent at most once per period and the
-- schedule survives restarts. period_key is e.g. '2026-11-09' (daily) or
-- '2026-W45' (weekly).
CREATE TABLE IF NOT EXISTS report_runs (
  period_key text PRIMARY KEY,
  sent_at    bigint NOT NULL
);
