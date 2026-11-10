-- One-shot "update now" trigger an owner can send to a device from the dashboard.
-- Kept separate from `command` so it never clobbers a paused/uninstalling state.
ALTER TABLE devices ADD COLUMN update_requested boolean NOT NULL DEFAULT false;
