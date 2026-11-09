-- First-class teams, plus app rules that can be global or scoped to a team.
CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  created_at  bigint NOT NULL
);

ALTER TABLE employees ADD COLUMN team_id uuid REFERENCES teams(id) ON DELETE SET NULL;
ALTER TABLE app_rules ADD COLUMN team_id uuid REFERENCES teams(id) ON DELETE CASCADE;

CREATE INDEX employees_team ON employees (team_id);
CREATE INDEX app_rules_team ON app_rules (team_id);

-- Backfill: every distinct non-null, non-empty employees.team string becomes a team,
-- and those employees are linked to it. The legacy `team` text column is kept as-is.
INSERT INTO teams (name, created_at)
SELECT DISTINCT trim(team), (extract(epoch FROM now()) * 1000)::bigint
FROM employees
WHERE team IS NOT NULL AND trim(team) <> ''
ON CONFLICT (name) DO NOTHING;

UPDATE employees e
SET team_id = t.id
FROM teams t
WHERE e.team IS NOT NULL AND trim(e.team) = t.name;
