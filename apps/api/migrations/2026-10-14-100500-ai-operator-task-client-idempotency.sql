-- AI Operator: admission idempotency key (#5205 W08, #5246), spec §12.
--
-- `POST /api/v1/ai/operator/tasks` carries a client idempotency key. A
-- duplicate POST must return the SAME task id and must never admit a second
-- task, because each task can dispatch a real service-restart command to a
-- customer machine — a second admission is a duplicate remediation effect.
--
-- The guarantee is a PARTIAL UNIQUE INDEX rather than a route-level
-- read-then-insert: two concurrent clicks (or a client retry racing its own
-- first request) both pass a SELECT and both insert. Only the database can
-- serialize them.
--
-- Partial on `client_idempotency_key IS NOT NULL` so every pre-existing row
-- and every internally-admitted task (the coordinator's successors, recovery
-- scans) keeps a NULL and never collides. Scoped by `org_id` so one tenant can
-- neither probe nor squat another tenant's keys.
--
-- No RLS change: `ai_operator_tasks` is tenancy shape 1 (direct NOT NULL
-- `org_id`) and its policies are column-agnostic. The new column IS registered
-- in CORE_TENANT_EXPORT_POLICY in the same PR — adding a column to an
-- org-cascade table breaks that contract test, which is exactly the point.
--
-- No DML in this file, so no `breeze.scope` elevation is required.

ALTER TABLE ai_operator_tasks
  ADD COLUMN IF NOT EXISTS client_idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_tasks_client_idempotency_uq
  ON ai_operator_tasks (org_id, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;
