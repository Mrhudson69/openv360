CREATE TABLE admins (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    bigint NOT NULL
);

CREATE TABLE admin_sessions (
  token_hash  text PRIMARY KEY,
  admin_id    uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at  bigint NOT NULL,
  expires_at  bigint NOT NULL
);

CREATE TABLE employees (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  email       text,
  team        text,
  created_at  bigint NOT NULL
);

CREATE TABLE enrollment_codes (
  code         text PRIMARY KEY,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  expires_at   bigint NOT NULL,
  used_at      bigint
);

CREATE TABLE devices (
  id             uuid PRIMARY KEY,
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  token_hash     text NOT NULL UNIQUE,
  hostname       text NOT NULL,
  os             text NOT NULL,
  os_version     text NOT NULL,
  agent_version  text NOT NULL,
  created_at     bigint NOT NULL,
  last_seen_at   bigint,
  revoked_at     bigint
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('clock_in', 'clock_out')),
  at          bigint NOT NULL
);
CREATE INDEX sessions_emp_at ON sessions (employee_id, at);

CREATE TABLE segments (
  id          uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  start_at    bigint NOT NULL,
  end_at      bigint NOT NULL,
  idle        boolean NOT NULL,
  app         text NOT NULL,
  title       text NOT NULL DEFAULT ''
);
CREATE INDEX segments_emp_start ON segments (employee_id, start_at);

CREATE TABLE screenshots (
  id          uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  taken_at    bigint NOT NULL,
  path        text NOT NULL,
  mime        text NOT NULL,
  size_bytes  integer NOT NULL
);
CREATE INDEX screenshots_emp_taken ON screenshots (employee_id, taken_at);

CREATE TABLE settings (
  id                      integer PRIMARY KEY CHECK (id = 1),
  screenshots_enabled     boolean NOT NULL DEFAULT true,
  screenshot_interval_sec integer NOT NULL DEFAULT 600,
  screenshot_blur         boolean NOT NULL DEFAULT false,
  idle_threshold_sec      integer NOT NULL DEFAULT 300,
  track_window_titles     boolean NOT NULL DEFAULT true
);
INSERT INTO settings (id) VALUES (1);

CREATE TABLE app_rules (
  id          uuid PRIMARY KEY,
  seq         bigserial NOT NULL,
  pattern     text NOT NULL,
  category    text NOT NULL CHECK (category IN ('productive', 'unproductive', 'neutral')),
  created_at  bigint NOT NULL
);
