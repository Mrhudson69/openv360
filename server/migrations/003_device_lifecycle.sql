-- Remote command the agent polls for, and integrity flags.
ALTER TABLE devices ADD COLUMN command text NOT NULL DEFAULT 'none'
  CHECK (command IN ('none', 'stop', 'uninstall'));
ALTER TABLE devices ADD COLUMN flag_count integer NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN suspicious_at bigint;
