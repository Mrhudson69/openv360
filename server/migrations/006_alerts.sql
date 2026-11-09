-- Alert rules that fire on activity/attendance conditions and deliver to a
-- webhook (Slack-compatible or generic JSON) or SMTP email, plus the log of
-- fired events (for de-duplication and an admin audit trail).
CREATE TABLE alert_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type           text NOT NULL,
  name           text NOT NULL,
  params         jsonb NOT NULL DEFAULT '{}',
  channel_kind   text NOT NULL,
  channel_target text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     bigint NOT NULL
);

CREATE TABLE alert_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id        uuid REFERENCES alert_rules(id) ON DELETE CASCADE,
  employee_id    uuid,
  device_id      uuid,
  message        text NOT NULL,
  created_at     bigint NOT NULL,
  delivered      boolean NOT NULL DEFAULT false,
  delivery_error text,
  dedupe_key     text NOT NULL
);

-- Fast de-dup lookups per (rule, subject bucket) and newest-first event listing.
CREATE INDEX alert_events_rule_dedupe ON alert_events (rule_id, dedupe_key, created_at);
CREATE INDEX alert_events_created ON alert_events (created_at);
