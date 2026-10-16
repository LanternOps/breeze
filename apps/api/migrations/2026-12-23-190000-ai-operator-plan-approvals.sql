-- Operator Recipe Library wave E4 (#6169) — plan approval (spec §5.4, §6.4).
--
-- WHAT THIS IS. One four-eyes decision over an ORDERED, DIGEST-PINNED SET of
-- provider effects, carried by exactly ONE ordinary action intent
-- (tool `operator_plan`) on the existing approval_requests flow. These two
-- tables are plan CONTENT only — never a second decision path: who decided,
-- and how, stays on action_intents / approval_requests.
--
-- THINGS THAT ARE DELIBERATE AND MUST NOT BE "SIMPLIFIED":
--
--  A. The effect SET is CHILD ROWS, not jsonb. Membership is checked at
--     RELEASE, from these rows, against the same rows the approver's card was
--     rendered from. A jsonb blob would also be `excludedOpen` in
--     CORE_TENANT_EXPORT_POLICY and drop the record of what was done to a
--     person out of a tenant export.
--
--  B. `effect_set_digest` is a SECOND, independent seal over those rows,
--     computed by the SAME canonicalizer action_intents.argument_digest uses.
--
--  C. UNIQUE (org_id, task_id, plan_revision) makes supersession total: a new
--     plan needs a new revision.
--
--  D. `intent_id` is NULLABLE, but only while `state = 'pending'`. The rows are
--     written BEFORE the operator_plan intent is minted so that the intent's
--     effect-digest resolver (EFFECT_DIGEST_RESOLVERS.operator_plan) pins a
--     digest over rows that already exist; action_intents.effect_digest is
--     immutable after insert, so the order cannot be reversed. The link is
--     stamped by a single `WHERE intent_id IS NULL` UPDATE right after the
--     mint (or by the approval CAS itself, if the release outran that UPDATE).
--     A plan can only be APPROVED or REJECTED through its intent, so those two
--     states require the link; `superseded` / `expired` may be reached by an
--     unbound plan (a crash between the row write and the mint).
--
--  E. `step_key` names the effect step that owns the plan. A child effect's
--     task_step_key and operation_key must be exactly the ones derived from
--     (step_key, plan_revision, tool, target, ordinal) — membership alone does
--     not bind the dispatch identity, and an operation key with a different
--     step or target segment would otherwise be a second operation for the
--     same approved slot.
--
-- NO ROWS ARE WRITTEN BY THIS FILE (DDL only), so it elects no breeze.scope.
-- Idempotent throughout. No inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS ai_operator_plan_approvals (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES organizations(id),
  task_id                  uuid NOT NULL,
  step_key                 text NOT NULL,
  -- = ai_operator_tasks.revision when the plan was proposed. Release-time
  -- membership requires the task's LIVE revision to still equal this.
  plan_revision            integer NOT NULL,
  effect_set_digest        char(64) NOT NULL,
  -- Membership asserts this equals the number of child rows, so a partially
  -- deleted set is detectable rather than silently narrowing the approval.
  effect_count             integer NOT NULL,
  intent_id                uuid,
  state                    text NOT NULL DEFAULT 'pending',
  -- Copied from the operator_plan intent's decision when it is released.
  approved_by_user_id      uuid,
  approved_at              timestamptz,
  approved_assurance_level smallint,
  superseded_by_revision   integer,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_operator_plan_approvals_state_chk
    CHECK (state IN ('pending','approved','rejected','expired','superseded')),
  CONSTRAINT ai_operator_plan_approvals_effect_count_chk
    CHECK (effect_count > 0 AND effect_count <= 64),
  CONSTRAINT ai_operator_plan_approvals_revision_chk
    CHECK (plan_revision >= 0),
  CONSTRAINT ai_operator_plan_approvals_digest_chk
    CHECK (effect_set_digest ~ '^[0-9a-f]{64}$'),
  -- `approved` always carries its stamp time. The APPROVER is written by the
  -- approval CAS (markPlanApproved) but cannot be required here: the
  -- approver FK is ON DELETE SET NULL, so a user hard-delete nulls it on an
  -- approved row. That is safe by design — membership refuses an approved
  -- plan whose approver is gone (plan_not_approved), so a deleted approver
  -- revokes every undispatched effect rather than leaving them authorized.
  CONSTRAINT ai_operator_plan_approvals_approved_chk
    CHECK (state <> 'approved' OR approved_at IS NOT NULL),
  CONSTRAINT ai_operator_plan_approvals_superseded_chk
    CHECK (state <> 'superseded' OR superseded_by_revision IS NOT NULL),
  CONSTRAINT ai_operator_plan_approvals_step_key_len_chk
    CHECK (char_length(step_key) BETWEEN 1 AND 64),
  -- See D above: a decision can only arrive through the intent.
  CONSTRAINT ai_operator_plan_approvals_intent_link_chk
    CHECK (state NOT IN ('approved','rejected') OR intent_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ai_operator_plan_approval_effects (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id),
  approval_id          uuid NOT NULL,
  task_id              uuid NOT NULL,
  plan_revision        integer NOT NULL,
  ordinal              integer NOT NULL,
  tool_name            text NOT NULL,
  provider             text NOT NULL,
  -- ai_operator_task_targets.id. Typed reference, no hard FK: an evidence row
  -- must not be rewritten by a target delete (and UPDATE is blocked below).
  target_id            uuid,
  -- Entra object id / Google user id — immutable, never the UPN.
  account_external_id  text,
  -- SHA-256 of the canonicalized arguments, same function as
  -- action_intents.argument_digest. With (task_id, plan_revision, ordinal)
  -- this IS the membership key checked at release.
  argument_digest      char(64) NOT NULL,
  -- Frozen display labels: what the approver read is what is stored.
  target_label         text NOT NULL,
  principal_label      text,
  rendering            text NOT NULL,
  idempotency_class    text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_operator_plan_approval_effects_provider_chk
    CHECK (provider IN ('breeze','m365','google')),
  CONSTRAINT ai_operator_plan_approval_effects_idempotency_class_chk
    CHECK (idempotency_class IN ('idempotent','idempotent_by_probe','non_idempotent')),
  CONSTRAINT ai_operator_plan_approval_effects_ordinal_chk
    CHECK (ordinal >= 0 AND ordinal < 64),
  CONSTRAINT ai_operator_plan_approval_effects_digest_chk
    CHECK (argument_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ai_operator_plan_approval_effects_tool_name_len_chk
    CHECK (char_length(tool_name) BETWEEN 1 AND 128),
  CONSTRAINT ai_operator_plan_approval_effects_rendering_len_chk
    CHECK (char_length(rendering) BETWEEN 1 AND 500),
  CONSTRAINT ai_operator_plan_approval_effects_target_label_len_chk
    CHECK (char_length(target_label) BETWEEN 1 AND 200),
  CONSTRAINT ai_operator_plan_approval_effects_principal_label_len_chk
    CHECK (principal_label IS NULL OR char_length(principal_label) BETWEEN 1 AND 320),
  -- A breeze effect names a device row, not a provider account (spec §6.4).
  CONSTRAINT ai_operator_plan_approval_effects_account_chk
    CHECK (provider <> 'breeze' OR account_external_id IS NULL)
);

-- ── uniqueness ──────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_plan_approvals_task_revision_uq
  ON ai_operator_plan_approvals (org_id, task_id, plan_revision);

-- Composite-FK target for the child rows: an effect can never name an
-- approval of a different task or a different org.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_plan_approvals_id_task_org_uq
  ON ai_operator_plan_approvals (id, task_id, org_id);

-- One intent carries at most one plan. (NULLs are distinct: pending rows
-- awaiting their link do not collide.)
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_plan_approvals_intent_uq
  ON ai_operator_plan_approvals (org_id, intent_id);

CREATE INDEX IF NOT EXISTS ai_operator_plan_approvals_task_state_idx
  ON ai_operator_plan_approvals (org_id, task_id, state);

-- THE membership index. The release check reads exactly this tuple.
CREATE UNIQUE INDEX IF NOT EXISTS ai_operator_plan_approval_effects_membership_uq
  ON ai_operator_plan_approval_effects (org_id, task_id, plan_revision, ordinal);

CREATE INDEX IF NOT EXISTS ai_operator_plan_approval_effects_approval_idx
  ON ai_operator_plan_approval_effects (approval_id, ordinal);

-- ── foreign keys ────────────────────────────────────────────────────────────
-- Every composite FK naming an org_id column is DEFERRABLE INITIALLY IMMEDIATE
-- (org merge runs SET CONSTRAINTS ALL DEFERRED).

DO $$ BEGIN
  ALTER TABLE ai_operator_plan_approvals
    ADD CONSTRAINT ai_operator_plan_approvals_task_org_fk
    FOREIGN KEY (task_id, org_id) REFERENCES ai_operator_tasks (id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ai_operator_plan_approvals
    ADD CONSTRAINT ai_operator_plan_approvals_intent_org_fk
    FOREIGN KEY (intent_id, org_id) REFERENCES action_intents (id, org_id)
    -- RESTRICT: an approval whose intent vanished must stay visible as a
    -- broken row, not disappear with the evidence of who approved what.
    -- (Org erasure orders deletes from the FK graph at runtime.)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ai_operator_plan_approvals
    ADD CONSTRAINT ai_operator_plan_approvals_approver_fk
    FOREIGN KEY (approved_by_user_id) REFERENCES users (id)
    -- Attribution, not tenancy. approved_at survives a user delete.
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ai_operator_plan_approval_effects
    ADD CONSTRAINT ai_operator_plan_approval_effects_approval_task_org_fk
    FOREIGN KEY (approval_id, task_id, org_id)
    REFERENCES ai_operator_plan_approvals (id, task_id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── RLS: Shape 1, ENABLE + FORCE, four policies ─────────────────────────────

ALTER TABLE ai_operator_plan_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_plan_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_plan_approval_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_operator_plan_approval_effects FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select_ai_operator_plan_approvals ON ai_operator_plan_approvals;
CREATE POLICY breeze_org_isolation_select_ai_operator_plan_approvals ON ai_operator_plan_approvals
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert_ai_operator_plan_approvals ON ai_operator_plan_approvals;
CREATE POLICY breeze_org_isolation_insert_ai_operator_plan_approvals ON ai_operator_plan_approvals
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update_ai_operator_plan_approvals ON ai_operator_plan_approvals;
CREATE POLICY breeze_org_isolation_update_ai_operator_plan_approvals ON ai_operator_plan_approvals
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete_ai_operator_plan_approvals ON ai_operator_plan_approvals;
CREATE POLICY breeze_org_isolation_delete_ai_operator_plan_approvals ON ai_operator_plan_approvals
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DROP POLICY IF EXISTS breeze_org_isolation_select_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects;
CREATE POLICY breeze_org_isolation_select_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects;
CREATE POLICY breeze_org_isolation_insert_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects;
CREATE POLICY breeze_org_isolation_update_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects;
CREATE POLICY breeze_org_isolation_delete_ai_operator_plan_approval_effects ON ai_operator_plan_approval_effects
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ── immutability ────────────────────────────────────────────────────────────
-- An approved effect row is EVIDENCE of what a human authorized. UPDATE is
-- revoked (re-revoked on every boot by db/ensureAppRole.ts, whose blanket
-- GRANT would otherwise re-permit it) and a trigger backs it up for every
-- role. DELETE stays available so org erasure / the task cascade can reap it.

REVOKE UPDATE ON ai_operator_plan_approval_effects FROM breeze_app;

CREATE OR REPLACE FUNCTION ai_operator_plan_approval_effects_block_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'ai_operator_plan_approval_effects rows are immutable: an approved effect set is the evidence of what a human authorized. Supersede the plan and write a new revision.'
    USING ERRCODE = 'raise_exception';
END $$;

DROP TRIGGER IF EXISTS ai_operator_plan_approval_effects_no_update ON ai_operator_plan_approval_effects;
CREATE TRIGGER ai_operator_plan_approval_effects_no_update
  BEFORE UPDATE ON ai_operator_plan_approval_effects
  FOR EACH ROW EXECUTE FUNCTION ai_operator_plan_approval_effects_block_update();

-- The approval row's CONTENT is just as fixed: only the lifecycle columns
-- (state, approval stamp, supersession, the one-shot intent link,
-- updated_at) may move. A plan whose digest, count, task or revision could be
-- edited in place would let the seal be swapped under a live decision.
CREATE OR REPLACE FUNCTION ai_operator_plan_approvals_block_content_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.task_id IS DISTINCT FROM OLD.task_id
     OR NEW.step_key IS DISTINCT FROM OLD.step_key
     OR NEW.plan_revision IS DISTINCT FROM OLD.plan_revision
     OR NEW.effect_set_digest IS DISTINCT FROM OLD.effect_set_digest
     OR NEW.effect_count IS DISTINCT FROM OLD.effect_count
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     -- The link may be set once (NULL -> value) and never re-pointed.
     OR (OLD.intent_id IS NOT NULL AND NEW.intent_id IS DISTINCT FROM OLD.intent_id) THEN
    RAISE EXCEPTION 'ai_operator_plan_approvals content is immutable'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ai_operator_plan_approvals_immutable_trg ON ai_operator_plan_approvals;
CREATE TRIGGER ai_operator_plan_approvals_immutable_trg
  BEFORE UPDATE ON ai_operator_plan_approvals
  FOR EACH ROW EXECUTE FUNCTION ai_operator_plan_approvals_block_content_update();

-- The SET is closed once a human could have seen it. An effect row may be
-- inserted only while its approval is still pending AND unlinked (the
-- proposal transaction); afterwards a DELETE+INSERT "replacement" at the same
-- ordinal is refused here, and is independently caught at release because
-- membership recomputes effect_set_digest from the rows.
CREATE OR REPLACE FUNCTION ai_operator_plan_approval_effects_block_late_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_state text;
  parent_intent uuid;
BEGIN
  SELECT state, intent_id INTO parent_state, parent_intent
    FROM ai_operator_plan_approvals
   WHERE id = NEW.approval_id AND task_id = NEW.task_id AND org_id = NEW.org_id;
  IF parent_state IS DISTINCT FROM 'pending' OR parent_intent IS NOT NULL THEN
    RAISE EXCEPTION 'ai_operator_plan_approval_effects: the effect set is closed once the plan is linked to its approval intent'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ai_operator_plan_approval_effects_closed_set ON ai_operator_plan_approval_effects;
CREATE TRIGGER ai_operator_plan_approval_effects_closed_set
  BEFORE INSERT ON ai_operator_plan_approval_effects
  FOR EACH ROW EXECUTE FUNCTION ai_operator_plan_approval_effects_block_late_insert();
