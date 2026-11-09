-- Work-schedule settings used by the attendance analytics: the expected work
-- window (minutes past local midnight) and the set of workdays as a weekday
-- bitmask (bit i = weekday i, 0=Sunday..6=Saturday; 62 = Mon-Fri = bits 1..5).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS work_start_min int NOT NULL DEFAULT 540;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS work_end_min int NOT NULL DEFAULT 1080;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS workdays int NOT NULL DEFAULT 62;
