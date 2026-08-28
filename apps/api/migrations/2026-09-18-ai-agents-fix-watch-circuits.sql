-- Wave 6.2a (#3828): "did the fix hold" watches, plus the circuit ledger they
-- feed. Template: 2026-09-16-ai-agents-policy-decide-foundations.sql, which
-- created ai_unattended_exposure under the same Shape-1 contract.
--
-- INERTNESS CONTRACT for ai_agent_circuits: this wave WRITES the table
-- (counters accumulate as a watch regresses and as an immediate act
-- verification fails) but NO code path READS it to make a decision. Wave 6.2b
-- adds the enforcing gate, and it has to add it in THREE places rather than
-- one: "downgrade to propose" does not mean "a human must approve" in Breeze.
-- A tier-3 proposal becomes an action intent (runLoop.ts's recordProposal ->
-- createActionIntent), and attemptPolicyDecision can authorize that intent
-- unattended for anything in POLICY_DECIDABLE_TIER3 — which includes
-- manage_services:restart, the exact op this wave watches. Gating only the act
-- branch would let the breaker route around itself. See the plan doc
-- (docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-2a-fix-watch.md),
-- decision 11.
--
-- Two tables:
--
-- 1. ai_agent_fix_watches — one row per watchable act execution. Two lanes,
--    discriminated by watch_kind:
--      * 'alert_recurrence' — op-agnostic, a pure DB read (did an alert of the
--        same identity re-trigger on this device after baseline_at?). Resolves
--        while the device is offline, and is the ONLY lane that says anything
--        about run_script or execute_playbook.
--      * 'postcondition' — re-runs the op's own verifySpec read-back.
--        'service_running' is the only kind v1 watches: process_absent is not
--        in the act manifest at all, and a by-name re-check would be a broader
--        claim than the postcondition rather than a weaker one;
--        disk_usage_improved's verification never performs a disk read
--        (actVerify.ts:168-186), so there is no baseline to compare against.
--
--    'checking' is a LEASE, not a terminal state — the sweeper claims a due
--    row, performs the bounded device read OUTSIDE any transaction, then
--    finalizes. A worker that dies mid-check leaves the row reclaimable once
--    lease_expires_at passes.
--
-- 2. ai_agent_circuits — live breaker state, keyed per TARGET
--    (org, agent, device, op_key, target_fingerprint) and not merely per op:
--    a failed restart of service A must not block service B, and one failed
--    script must not block every script. `epoch` is what stops a stale watch
--    from resurrecting a manually-reset circuit.
--
-- Both tables are org-owned OPERATIONAL records, not config, so neither takes
-- the Partner-Wide First dual-ownership shape: each describes one concrete
-- action on one device in one target org, exactly as ai_agent_runs does while
-- its agent_id may still name a partner-wide agent. Configurable thresholds
-- and watch intervals belong in the already dual-owned agent policy surface.
--
-- Registration (all six lists, same PR): CORE_ORG_CASCADE_DELETE_ORDER,
-- CORE_DEVICE_CASCADE_DELETE_TABLES, CORE_DEVICE_ORG_MOVE_DELETE_TABLES
-- (these are its FIRST two entries), INTENTIONALLY_NO_ORG_ID in
-- moveOrg.coverage.test.ts, CORE_TENANT_EXPORT_POLICY, and orgMergeRegistry.
-- On a cross-org device move the rows are DELETED, never re-stamped: a
-- re-stamped pending watch would fire a device command against a device now
-- owned by a different tenant, and would carry the source tenant's target data
-- into the destination org.
--
-- Idempotent throughout (CREATE TABLE/INDEX IF NOT EXISTS, DO-guarded
-- constraint and policy adds). No inner BEGIN/COMMIT — autoMigrate wraps the
-- whole file in one transaction.

-- ---------------------------------------------------------------------------
-- 1. ai_agent_fix_watches
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_fix_watches (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE, unlike ai_agent_runs.device_id's SET NULL: a watch
  -- against a deleted device has nothing left to re-check.
  device_id               uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  agent_id                uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  run_id                  uuid NOT NULL,
  watch_kind              text NOT NULL,
  contract_version        integer NOT NULL,
  op_key                  text NOT NULL,
  target_fingerprint      text NOT NULL,
  verify_spec_kind        text,
  target                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The FK may go NULL long before the watch falls due (an alert can be
  -- resolved or deleted), so the alert IDENTITY is captured alongside it —
  -- recurrence is a question about the identity, not about that row.
  alert_id                uuid REFERENCES alerts(id) ON DELETE SET NULL,
  alert_rule_id           uuid,
  alert_config_item_name  varchar(200),
  baseline_at             timestamptz NOT NULL,
  due_at                  timestamptz NOT NULL,
  status                  text NOT NULL DEFAULT 'pending',
  attempts                integer NOT NULL DEFAULT 0,
  lease_expires_at        timestamptz,
  checked_at              timestamptz,
  detail                  text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_fix_watches_kind_chk
    CHECK (watch_kind IN ('alert_recurrence', 'postcondition')),
  CONSTRAINT ai_agent_fix_watches_status_chk
    CHECK (status IN ('pending', 'checking', 'held', 'regressed', 'inconclusive', 'cancelled')),
  -- Composite rather than a bare run_id FK: this makes it structurally
  -- impossible for a watch to name a run belonging to a different tenant.
  -- ai_agent_runs_id_org_id_key exists for exactly this purpose.
  CONSTRAINT ai_agent_fix_watches_run_org_fk
    FOREIGN KEY (run_id, org_id) REFERENCES ai_agent_runs(id, org_id) ON DELETE CASCADE,
  -- Makes scheduleFixWatches idempotent under a retried finishRun.
  CONSTRAINT ai_agent_fix_watches_run_kind_target_uq
    UNIQUE (run_id, watch_kind, target_fingerprint)
);

-- The sweeper's due-scan. Partial on the two claimable states so it stays
-- small as terminal rows accumulate ahead of the retention sweep.
CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_due_idx
  ON ai_agent_fix_watches(status, due_at)
  WHERE status IN ('pending', 'checking');
CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_run_idx
  ON ai_agent_fix_watches(run_id);
CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_org_created_idx
  ON ai_agent_fix_watches(org_id, created_at DESC);

ALTER TABLE ai_agent_fix_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_fix_watches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_fix_watches_isolation ON ai_agent_fix_watches;
CREATE POLICY ai_agent_fix_watches_isolation ON ai_agent_fix_watches
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_fix_watches TO breeze_app;

-- ---------------------------------------------------------------------------
-- 2. ai_agent_circuits  (written this wave, read by no gate until 6.2b)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_agent_circuits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id             uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  agent_id              uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  op_key                text NOT NULL,
  target_fingerprint    text NOT NULL,
  epoch                 bigint NOT NULL DEFAULT 0,
  state                 text NOT NULL DEFAULT 'closed',
  failure_count         integer NOT NULL DEFAULT 0,
  consecutive_opens     integer NOT NULL DEFAULT 0,
  window_started_at     timestamptz NOT NULL DEFAULT now(),
  last_failure_at       timestamptz,
  last_failure_reason   text,
  opened_at             timestamptz,
  open_reason           text,
  reset_at              timestamptz,
  -- ON DELETE SET NULL: a deleted operator must not take the reset record's
  -- circuit with them.
  reset_by_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_agent_circuits_state_chk CHECK (state IN ('closed', 'open'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_circuits_target_uq
  ON ai_agent_circuits(org_id, agent_id, device_id, op_key, target_fingerprint);
CREATE INDEX IF NOT EXISTS ai_agent_circuits_org_state_idx
  ON ai_agent_circuits(org_id, state);
CREATE INDEX IF NOT EXISTS ai_agent_circuits_device_idx
  ON ai_agent_circuits(device_id);

ALTER TABLE ai_agent_circuits ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_circuits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_circuits_isolation ON ai_agent_circuits;
CREATE POLICY ai_agent_circuits_isolation ON ai_agent_circuits
  USING (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_circuits TO breeze_app;
