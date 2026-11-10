-- How long (seconds) a user must be continuously idle before screenshots pause.
-- Screenshots resume automatically when the user is active again.
-- 0 = never pause (always capture every interval, idle or not).
ALTER TABLE settings ADD COLUMN screenshot_idle_stop_sec integer NOT NULL DEFAULT 600;
