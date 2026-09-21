-- #6509 — DELETE /monitor-definitions/:id 500ed with the raw postgres FK
-- error `alerts_rule_id_alert_rules_id_fk` once the monitor had ever fired.
--
-- Root cause: monitor_definitions -> alert_rules.managed_by_monitor_id
-- (2026-10-16-160300) cascades ON DELETE, so deleting a compiled monitor
-- deletes its compiled alert_rules row. alerts.rule_id -> alert_rules.id
-- (0001-baseline) had no ON DELETE action, so any alerts row still pointing
-- at that rule aborted the whole delete with a 23503 the route had no mapping
-- for and let bubble to the client as a raw constraint-violation 500.
--
-- alerts.monitor_id already resolves this the same way (SET NULL,
-- 2026-10-16-160300, "alerts keep their history with monitor_id set to
-- NULL") — rule_id was simply missed when that column was added. The
-- 2026-08-08 comment that alert_rules rows are "DEACTIVATED, never deleted"
-- predates the monitor-definitions cascade and is no longer the whole story:
-- a monitor-managed rule genuinely can be deleted now, and a legacy
-- (non-monitor) rule can already be hard-deleted via DELETE
-- /alerts/rules/:id (routes/alerts/rules.ts). Either way the alert is
-- historical evidence that already carries its own title/message/context;
-- losing the now-defunct rule pointer is not losing information the alert
-- needs.
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_rule_id_alert_rules_id_fk;
ALTER TABLE alerts ADD CONSTRAINT alerts_rule_id_alert_rules_id_fk
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE SET NULL;
