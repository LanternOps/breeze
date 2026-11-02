-- AI Operator: durable per-provider-account reservations (#9981).
--
-- THE BUG. Admission serialised on `(recipe, contact)` and refused a second
-- LIVE task for the same contact. Two contact rows that resolve to the same
-- Microsoft 365 / Google Workspace account both got through, so two
-- offboardings could suspend, reroute mail and revoke sessions on one account
-- at the same time. And because the check ignored terminal tasks, a task that
-- settled `handed_off` with outcome `unknown_effect` (a dispatched effect may
-- still land) released the exclusion while its effect could still be running.
--
-- THE FIX. A task reserves every provider account it will act on, keyed on the
-- provider identity (`provider`, immutable `external_id`) inside the org. The
-- partial unique index below is the guarantee: two ACTIVE reservations of one
-- account in one org are unrepresentable, whichever code path writes them.
-- Admission takes a transaction-scoped advisory lock per account in sorted
-- order and reads this table first, so the normal refusal is a clean
-- `account_reserved` naming the holder; the index is the backstop that turns
-- any writer that skipped the check into an aborted transaction, never a
-- second concurrent offboarding.
--
-- LIFECYCLE (released_at IS NULL = active):
--  - held while the task is live (queued/running/waiting/paused/stopping);
--  - released by the trigger at the bottom of this file the moment the task
--    reaches a terminal state, UNLESS its outcome is `unknown_effect` or an
--    operation it dispatched has not settled;
--  - an `unknown_effect` reservation is released by the reconciler once no
--    operation of the task can still land ('effects_settled'), or by a person
--    through the API after confirming the provider ('released_by_user');
--  - a re-freeze of a task's account replaces it ('superseded').
-- There is deliberately NO time-based expiry: an operation whose result stays
-- `unknown` may still have landed, and only a person can confirm that.
--
-- TENANCY. Shape 1, org_id NOT NULL. Not a config/policy table (it is runtime
-- state hanging off one org-scoped task), so partner-wide-first does not apply.
-- Provider connections are per org, and a task belongs to exactly one org.
--
-- Org merge leaves the task in the loser org (ai_operator_tasks is
-- leave-for-erasure), so this table is leave-for-erasure too; admission in the
-- survivor also reads the active reservations of every org merged into it
-- (org_merge_events), see accountReservations.ts.

CREATE TABLE IF NOT EXISTS ai_operator_account_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  task_id uuid NOT NULL,
  provider text NOT NULL
    CONSTRAINT ai_operator_account_reservations_provider_chk
    CHECK (provider IN ('m365', 'google')),
  -- Immutable Entra object id / Google user id. Never the UPN.
  external_id text NOT NULL
    CONSTRAINT ai_operator_account_reservations_external_id_len_chk
    CHECK (length(external_id) BETWEEN 1 AND 255),
  -- Display only, frozen at reservation.
  principal_label text NOT NULL
    CONSTRAINT ai_operator_account_reservations_principal_label_len_chk
    CHECK (length(principal_label) BETWEEN 1 AND 320),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text
    CONSTRAINT ai_operator_account_reservations_release_reason_chk
    CHECK (release_reason IN ('task_settled', 'effects_settled', 'released_by_user', 'superseded')),
  released_by_user_id uuid,
  release_note text
    CONSTRAINT ai_operator_account_reservations_release_note_len_chk
    CHECK (release_note IS NULL OR length(release_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_operator_account_reservations_release_pair_chk
    CHECK ((released_at IS NULL) = (release_reason IS NULL)),
  CONSTRAINT ai_operator_account_reservations_released_by_chk
    CHECK (released_by_user_id IS NULL OR release_reason = 'released_by_user')
);

-- THE guarantee: one active reservation per account per org.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_account_reservations_active_uq
  ON ai_operator_account_reservations (org_id, provider, external_id)
  WHERE released_at IS NULL;

-- The trigger's and the release paths' lookup by task.
CREATE INDEX IF NOT EXISTS ai_operator_account_reservations_task_idx
  ON ai_operator_account_reservations (org_id, task_id);

ALTER TABLE ai_operator_account_reservations DROP CONSTRAINT IF EXISTS ai_operator_account_reservations_task_org_fk;
ALTER TABLE ai_operator_account_reservations ADD CONSTRAINT ai_operator_account_reservations_task_org_fk
  FOREIGN KEY (task_id, org_id) REFERENCES ai_operator_tasks (id, org_id) ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

DO $$ BEGIN
  ALTER TABLE ai_operator_account_reservations
    ADD CONSTRAINT ai_operator_account_reservations_released_by_fk
    FOREIGN KEY (released_by_user_id) REFERENCES users (id)
    -- Attribution, not tenancy. released_at survives a user delete.
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE ai_operator_account_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_account_reservations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_operator_account_reservations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_operator_account_reservations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_operator_account_reservations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_operator_account_reservations;

CREATE POLICY breeze_org_isolation_select ON ai_operator_account_reservations
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_operator_account_reservations
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_operator_account_reservations
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_operator_account_reservations
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_operator_account_reservations TO breeze_app;

-- ---------------------------------------------------------------------------
-- Release on a clean terminal.
--
-- A trigger, not app code in `settle()`: ai_operator_tasks has more than a
-- dozen writers (coordinator, recipe advancers, plan approval, org merge,
-- device delete/move/reinstall), and a terminal write that forgot to release
-- would block the account until a person noticed. The trigger runs in the
-- writer's own transaction and RLS context; the writer could update the task,
-- so it can see the task's reservations.
--
-- Kept when the outcome is `unknown_effect` (an action it sent may still land
-- on the account), AND kept whatever the outcome when an operation of the
-- task was dispatched and has not settled: a terminal writer that chose a
-- different outcome must not free an account under an effect in flight. The
-- reconciler releases those once the operation settles. The task's own
-- outcome is written in the same UPDATE as its state (taskCoordinator
-- `settle`), so NEW.outcome is final here.
-- It touches no org_id and is AFTER UPDATE, so it is benign to the org-merge
-- repoint (ai_operator_tasks is not repointed at all).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ai_operator_tasks_release_account_reservations()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('completed', 'partial', 'handed_off', 'cancelled', 'failed', 'expired')
     AND OLD.state IS DISTINCT FROM NEW.state
     AND NEW.outcome IS DISTINCT FROM 'unknown_effect'
     AND NOT EXISTS (
           SELECT 1 FROM ai_operator_operations o
            WHERE o.org_id = NEW.org_id AND o.task_id = NEW.id
              AND o.result_state IN ('pending', 'unknown')
              AND (o.dispatch_state = 'dispatched' OR o.execution_ref_id IS NOT NULL))
  THEN
    UPDATE ai_operator_account_reservations
       SET released_at = now(),
           release_reason = 'task_settled',
           updated_at = now()
     WHERE org_id = NEW.org_id
       AND task_id = NEW.id
       AND released_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS ai_operator_tasks_release_account_reservations ON ai_operator_tasks;
CREATE TRIGGER ai_operator_tasks_release_account_reservations
  AFTER UPDATE OF state ON ai_operator_tasks
  FOR EACH ROW EXECUTE FUNCTION ai_operator_tasks_release_account_reservations();

-- ---------------------------------------------------------------------------
-- Backfill: the accounts of tasks that hold one today.
--
-- Live tasks, and terminal tasks with an operation that can still land (the
-- trigger's and the reconciler's predicate, whatever the outcome). Oldest task first, so when
-- the bug already let two live tasks share an account, the first admitted one
-- holds it; the other is counted and reported, not failed.
-- ---------------------------------------------------------------------------
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  inserted integer;
  shared integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  CREATE TEMP TABLE ai_operator_reservation_backfill ON COMMIT DROP AS
    SELECT a.org_id, a.task_id, a.provider, a.external_id, a.principal_label, t.created_at
      FROM ai_operator_task_target_accounts a
      JOIN ai_operator_tasks t ON t.id = a.task_id AND t.org_id = a.org_id
     WHERE t.state IN ('queued', 'running', 'waiting', 'paused', 'stopping')
        OR (EXISTS (
              SELECT 1 FROM ai_operator_operations o
               WHERE o.org_id = t.org_id AND o.task_id = t.id
                 AND o.result_state IN ('pending', 'unknown')
                 AND (o.dispatch_state = 'dispatched' OR o.execution_ref_id IS NOT NULL)));

  INSERT INTO ai_operator_account_reservations (org_id, task_id, provider, external_id, principal_label)
  SELECT b.org_id, b.task_id, b.provider, b.external_id, b.principal_label
    FROM ai_operator_reservation_backfill b
   WHERE NOT EXISTS (
           SELECT 1 FROM ai_operator_account_reservations r
            WHERE r.org_id = b.org_id AND r.task_id = b.task_id
              AND r.provider = b.provider AND r.external_id = b.external_id)
   ORDER BY b.created_at, b.task_id, b.provider
  ON CONFLICT (org_id, provider, external_id) WHERE released_at IS NULL DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;

  IF inserted > 0 THEN
    RAISE WARNING 'ai_operator_account_reservations: backfilled % reservation(s)', inserted;
  END IF;
  -- The bug's own footprint: a task whose account an older task holds.
  SELECT count(*) INTO shared
    FROM ai_operator_reservation_backfill b
   WHERE EXISTS (
           SELECT 1 FROM ai_operator_account_reservations r
            WHERE r.org_id = b.org_id AND r.provider = b.provider AND r.external_id = b.external_id
              AND r.released_at IS NULL AND r.task_id <> b.task_id);
  IF shared > 0 THEN
    RAISE WARNING 'ai_operator_account_reservations: % task account(s) are already held by an older task, so they were not reserved (#9981)', shared;
  END IF;
END $$;
