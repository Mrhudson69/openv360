-- Admin roles (owner / team manager) + audit log.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS team_id uuid NULL REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login_at bigint NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NULL REFERENCES admins(id) ON DELETE SET NULL,
  admin_name text NOT NULL DEFAULT '',
  action text NOT NULL,
  detail text NULL,
  at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at DESC);
