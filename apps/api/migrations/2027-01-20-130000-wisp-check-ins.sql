-- Wisp check-in timers W01 (#10992, feature #10991; spec
-- 2026-11-04-wisp-check-in-timers-design). Wisp schedules its own follow-up
-- on its thread: one row per check-in. A delayed `check-in` job on the
-- wisp-wake queue fires it (notifyUser writes a `check_in` thread post plus
-- the notification), and the grantor's next turn in the thread gets the
-- instruction prepended, after which the row is `consumed`.
--
-- Lifecycle: scheduled -> fired -> consumed; scheduled | fired -> cancelled.
--
-- Tenancy — shape 3, partner-anchored / org-optional, exactly the
-- wisp_thread_posts (2027-01-06-140000) shape: partner_id NOT NULL, org_id
-- NULL for a check-in on a partner-level thread, ONE FOR ALL policy
--   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
--          OR (org_id IS NULL AND breeze_has_partner_access(partner_id))
-- and NO breeze_current_partner_id() read branch: an org token must never
-- see a partner-level row. Registered in DUAL_AXIS_TENANT_TABLES,
-- CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry.ts (`repoint`) and
-- CORE_TENANT_EXPORT_POLICY (`context` is jsonb -> excludedOpen). The org
-- cascade's `WHERE org_id = $1` never touches partner-level rows (those leave
-- with the thread / grant / partner via ON DELETE CASCADE). The only unique
-- key is the PK, so a merge repoint cannot collide.
--
-- References are composite with partner_id, so a check-in can never point
-- across partners: thread (thread_id, partner_id) -> wisp_threads, grant
-- (grant_id, partner_id) -> wisp_grants, user (user_id, partner_id) -> users,
-- org (org_id, partner_id) -> organizations (DEFERRABLE INITIALLY IMMEDIATE:
-- org merge defers constraints). session_id has no FK: it is provenance only,
-- and the session may be erased before the check-in.
--
-- id has no default: the service generates it so job_id
-- (`wisp-check-in-<id>`) is written in the same INSERT.
--
-- The due-time window is checked against the row's own created_at, never
-- now(): a CHECK that reads now() would fail when a dump of old rows is
-- restored. The service inserts created_at from the same clock it validated
-- the window with.
--
-- Also widens wisp_thread_posts_kind_chk with 'check_in' (mirrors
-- WISP_TIMELINE_POST_KINDS in @breeze/shared; pinned by
-- threadPostKinds.contract.test.ts, which reads the LAST definition of the
-- CHECK across all migrations — keep the ADD on one line).
--
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file). The file
-- writes no rows and neither table has partner-export material triggers;
-- system scope is elected first anyway, per the migrations README.

SELECT set_config('breeze.scope', 'system', true);

CREATE TABLE IF NOT EXISTS wisp_check_ins (
  id            uuid PRIMARY KEY,
  partner_id    uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  -- NULL = a check-in on a partner-level thread (partner-scoped sessions only).
  org_id        uuid NULL,
  grant_id      uuid NOT NULL,
  thread_id     uuid NOT NULL,
  -- The session that scheduled it. Provenance only, no FK.
  session_id    uuid NULL,
  -- Who is notified when it fires (the grantor).
  user_id       uuid NOT NULL,
  due_at        timestamptz NOT NULL,
  -- What Wisp should do when it fires; written by the model.
  instruction   text NOT NULL,
  -- WispCheckInContext: { subject?: { kind, id } }.
  context       jsonb NULL,
  status        text NOT NULL DEFAULT 'scheduled',
  fired_at      timestamptz NULL,
  consumed_at   timestamptz NULL,
  cancelled_at  timestamptz NULL,
  -- BullMQ job id on wisp-wake (`wisp-check-in-<id>`), for cancel and reconcile.
  job_id        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_check_ins_status_chk') THEN
    ALTER TABLE wisp_check_ins
      ADD CONSTRAINT wisp_check_ins_status_chk
      CHECK (status IN ('scheduled','fired','consumed','cancelled'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_check_ins_instruction_len_chk') THEN
    ALTER TABLE wisp_check_ins
      ADD CONSTRAINT wisp_check_ins_instruction_len_chk
      CHECK (char_length(instruction) BETWEEN 1 AND 1000);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_check_ins_due_window_chk') THEN
    ALTER TABLE wisp_check_ins
      ADD CONSTRAINT wisp_check_ins_due_window_chk
      CHECK (
        due_at >= created_at + interval '1 minute'
        AND due_at <= created_at + interval '7 days'
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_check_ins_status_shape_chk') THEN
    ALTER TABLE wisp_check_ins
      ADD CONSTRAINT wisp_check_ins_status_shape_chk
      CHECK (
        (status <> 'fired' OR fired_at IS NOT NULL)
        AND (status <> 'consumed' OR (fired_at IS NOT NULL AND consumed_at IS NOT NULL))
        AND (status <> 'cancelled' OR cancelled_at IS NOT NULL)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_check_ins_thread_fk') THEN
    ALTER TABLE wisp_check_ins
      ADD CONSTRAINT wisp_check_ins_thread_fk
      FOREIGN KEY (thread_id, partner_id) REFERENCES wisp_threads (id, partner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_check_ins_grant_fk') THEN
    ALTER TABLE wisp_check_ins
      ADD CONSTRAINT wisp_check_ins_grant_fk
      FOREIGN KEY (grant_id, partner_id) REFERENCES wisp_grants (id, partner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_check_ins_user_fk') THEN
    ALTER TABLE wisp_check_ins
      ADD CONSTRAINT wisp_check_ins_user_fk
      FOREIGN KEY (user_id, partner_id) REFERENCES users (id, partner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wisp_check_ins_org_partner_fk') THEN
    ALTER TABLE wisp_check_ins
      ADD CONSTRAINT wisp_check_ins_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES organizations (id, partner_id)
      ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- The thread's live check-ins (per-thread cap, list, chip).
CREATE INDEX IF NOT EXISTS wisp_check_ins_thread_status_idx
  ON wisp_check_ins (thread_id, status);
-- The reconcile sweep: scheduled rows past due.
CREATE INDEX IF NOT EXISTS wisp_check_ins_scheduled_due_idx
  ON wisp_check_ins (due_at) WHERE status = 'scheduled';
-- The next-turn consume read, and the grant FK's cascade scan.
CREATE INDEX IF NOT EXISTS wisp_check_ins_grant_status_idx
  ON wisp_check_ins (grant_id, status);
-- Partner erasure and the partner-axis RLS branch.
CREATE INDEX IF NOT EXISTS wisp_check_ins_partner_idx ON wisp_check_ins (partner_id);
-- The user FK's cascade scan.
CREATE INDEX IF NOT EXISTS wisp_check_ins_user_idx ON wisp_check_ins (user_id);
-- Org cascade / org merge reach the org rows by org_id.
CREATE INDEX IF NOT EXISTS wisp_check_ins_org_idx ON wisp_check_ins (org_id) WHERE org_id IS NOT NULL;

-- RLS — ENABLE + FORCE in the creating file; one FOR ALL policy.
ALTER TABLE wisp_check_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE wisp_check_ins FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wisp_check_ins_isolation ON wisp_check_ins;
CREATE POLICY wisp_check_ins_isolation ON wisp_check_ins
  FOR ALL TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (org_id IS NULL AND public.breeze_has_partner_access(partner_id))
  );

-- The API connects as the unprivileged app role; DELETE is needed by the org
-- cascade and partner erasure, UPDATE by the lifecycle and org merge.
GRANT SELECT, INSERT, UPDATE, DELETE ON wisp_check_ins TO breeze_app;

-- Widen the thread-post kinds with 'check_in'. Drop + re-add is idempotent.
ALTER TABLE wisp_thread_posts DROP CONSTRAINT IF EXISTS wisp_thread_posts_kind_chk;
ALTER TABLE wisp_thread_posts ADD CONSTRAINT wisp_thread_posts_kind_chk CHECK (kind IN ('brief','nudge','digest','check_in'));
