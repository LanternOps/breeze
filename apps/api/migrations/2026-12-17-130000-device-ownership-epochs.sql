-- PAM ownership epochs W1 (#8203, feature #8202): epoch lineage foundation.
-- Spec: docs/superpowers/specs/pam/2026-10-06-pam-ownership-epoch-design.md §4.1, §4.2, §4.5.
--
-- Every org change on a device appends an immutable ownership epoch. This
-- migration adds the lineage only; nothing reads it yet, and the PAM history
-- move guard (devices_pam_history_move_guard) and the org-merge blocks-merge
-- policy keep refusing every PAM-touched move/merge until W6.
--
-- devices is a hot table. Nothing here rewrites or scans it:
--   * ADD COLUMN ... NOT NULL DEFAULT 1 (constant default) is catalog-only,
--     but takes ACCESS EXCLUSIVE, held until this file's transaction commits.
--   * The CHECK is added NOT VALID here (no scan). Its VALIDATE, and the
--     epoch-1 backfill, live in the NEXT migration (130100), which runs in its
--     own transaction after this lock is released; VALIDATE there takes only
--     SHARE UPDATE EXCLUSIVE.
--   * The two new UPDATE triggers on devices are column-scoped (UPDATE OF
--     org_id / UPDATE OF ownership_epoch), so heartbeat/status UPDATEs never
--     fire them. The third (init) fires only on INSERT (enrollment).
--
-- Writes to the three lineage tables happen only inside SECURITY DEFINER
-- trigger functions. breeze_app keeps SELECT (RLS-filtered) and DELETE
-- (device permanent deletion, org erasure) and nothing else; ensureAppRole.ts
-- re-revokes after its blanket boot-time GRANT.

SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- devices.ownership_epoch
-- ---------------------------------------------------------------------------
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS ownership_epoch integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.devices'::regclass AND conname = 'devices_ownership_epoch_chk'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_ownership_epoch_chk CHECK (ownership_epoch >= 1) NOT VALID;
  END IF;
END $$;
-- VALIDATE runs in 2026-12-17-130100 (see header).

-- ---------------------------------------------------------------------------
-- Lineage tables
-- ---------------------------------------------------------------------------
-- §4.1. Deliberately NO FK to devices: deleting a device in its current org
-- must never cascade into an earlier org's evidence (§4.4).
CREATE TABLE IF NOT EXISTS public.device_ownership_epochs (
  device_id  uuid        NOT NULL,
  epoch      integer     NOT NULL CHECK (epoch >= 1),
  org_id     uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  site_id    uuid,
  cause      text        NOT NULL
    CHECK (cause IN ('enrollment', 'backfill', 'device_move', 'org_merge', 'unspecified')),
  started_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_ownership_epochs_pkey PRIMARY KEY (device_id, epoch),
  CONSTRAINT device_ownership_epochs_device_org_epoch_key UNIQUE (device_id, org_id, epoch)
);
CREATE INDEX IF NOT EXISTS device_ownership_epochs_org_idx
  ON public.device_ownership_epochs (org_id);

-- §4.2. Display source for source-org history after the device has left.
CREATE TABLE IF NOT EXISTS public.device_ownership_epoch_closures (
  device_id             uuid        NOT NULL,
  epoch                 integer     NOT NULL,
  org_id                uuid        NOT NULL,
  closed_at             timestamptz NOT NULL DEFAULT now(),
  hostname_snapshot     varchar(255),
  display_name_snapshot varchar(255),
  site_id_snapshot      uuid,
  CONSTRAINT device_ownership_epoch_closures_pkey PRIMARY KEY (device_id, epoch),
  -- Composite FK over org_id: DEFERRABLE INITIALLY IMMEDIATE so org merge's
  -- SET CONSTRAINTS ALL DEFERRED can run (CLAUDE.md merge contract).
  CONSTRAINT device_ownership_epoch_closures_epoch_fkey
    FOREIGN KEY (device_id, org_id, epoch)
    REFERENCES public.device_ownership_epochs (device_id, org_id, epoch)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS device_ownership_epoch_closures_org_idx
  ON public.device_ownership_epoch_closures (org_id);

-- §4.5. Identifiers only, no org, no evidence. Lives exactly as long as the
-- live device. System scope only (intentionally system-scoped, like
-- device_commands).
CREATE TABLE IF NOT EXISTS public.pam_ledger_retirements (
  device_id     uuid        NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  actuation_id  uuid        NOT NULL,
  retired_epoch integer     NOT NULL,
  retired_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pam_ledger_retirements_pkey PRIMARY KEY (device_id, actuation_id)
);

-- ---------------------------------------------------------------------------
-- Append-only guards: UPDATE always refused (DELETE stays: erasure + device
-- deletion). Same 42501 style as the PAM transition guards.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_ownership_lineage_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = TG_TABLE_NAME || ' is append-only';
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['device_ownership_epochs', 'device_ownership_epoch_closures', 'pam_ledger_retirements'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_block_update', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.breeze_ownership_lineage_immutable()',
      t || '_block_update', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RLS. Epochs + closures: Shape 1 (direct org_id; breeze_has_org_access
-- already carries the system branch). Retirements: system only.
-- ---------------------------------------------------------------------------
ALTER TABLE public.device_ownership_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_ownership_epochs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.device_ownership_epoch_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_ownership_epoch_closures FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pam_ledger_retirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pam_ledger_retirements FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['device_ownership_epochs', 'device_ownership_epoch_closures'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation ON public.%I
         USING (public.breeze_has_org_access(org_id))
         WITH CHECK (public.breeze_has_org_access(org_id))', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS breeze_system_only ON public.pam_ledger_retirements;
CREATE POLICY breeze_system_only ON public.pam_ledger_retirements
  USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, DELETE ON public.device_ownership_epochs TO breeze_app;
    GRANT SELECT, DELETE ON public.device_ownership_epoch_closures TO breeze_app;
    GRANT SELECT, DELETE ON public.pam_ledger_retirements TO breeze_app;
    REVOKE INSERT, UPDATE, TRUNCATE ON public.device_ownership_epochs FROM breeze_app;
    REVOKE INSERT, UPDATE, TRUNCATE ON public.device_ownership_epoch_closures FROM breeze_app;
    REVOKE INSERT, UPDATE, TRUNCATE ON public.pam_ledger_retirements FROM breeze_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Caller-written ownership_epoch is refused. Only the advance trigger (which
-- changes it together with org_id) may move it. Fires only when the UPDATE's
-- target list names ownership_epoch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_device_ownership_epoch_write_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ownership_epoch IS DISTINCT FROM OLD.ownership_epoch
     AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'devices.ownership_epoch is trigger-managed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS devices_ownership_epoch_write_guard ON public.devices;
CREATE TRIGGER devices_ownership_epoch_write_guard
  BEFORE UPDATE OF ownership_epoch ON public.devices
  FOR EACH ROW
  EXECUTE FUNCTION public.breeze_device_ownership_epoch_write_guard();

-- ---------------------------------------------------------------------------
-- Epoch 1 on insert. SECURITY DEFINER with in-body system scope, saved and
-- restored before RETURN so it never leaks into the caller's transaction
-- (an error path aborts the statement, which rolls the set_config back too):
-- breeze_app holds no INSERT on the lineage tables, and the row it writes
-- mirrors a devices row that has already passed the devices RLS WITH CHECK.
-- A function-level SET "breeze.scope" attribute is not usable here: it needs
-- superuser in prod (42501, see migrationGucAttributes.test.ts).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_device_ownership_epoch_init()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO public.device_ownership_epochs (device_id, epoch, org_id, site_id, cause)
  VALUES (NEW.id, NEW.ownership_epoch, NEW.org_id, NEW.site_id, 'enrollment')
  ON CONFLICT DO NOTHING;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS devices_ownership_epoch_init ON public.devices;
CREATE TRIGGER devices_ownership_epoch_init
  AFTER INSERT ON public.devices
  FOR EACH ROW
  EXECUTE FUNCTION public.breeze_device_ownership_epoch_init();

-- ---------------------------------------------------------------------------
-- Advance on org change: close the departing epoch (with a display snapshot),
-- write one retirement marker per departing-epoch actuation, open epoch +1.
--
-- SECURITY DEFINER + system scope is required: pam_ledger_retirements is
-- system-only, the lineage tables grant breeze_app no INSERT, and the
-- pam_actuations read must see the source org's rows. Scope is elevated
-- in-body and restored to the caller's value before every RETURN, so it never
-- leaks into the rest of the caller's transaction (error paths abort the
-- statement, which rolls the set_config back). A function-level
-- SET "breeze.scope" attribute is not usable: it needs superuser in prod.
--
-- The cause comes from the transaction-local GUC breeze.ownership_change_cause;
-- anything other than device_move / org_merge records 'unspecified'. W1 does
-- not set it from any route; W6 does.
--
-- Fires before devices_pam_history_move_guard ('o' < 'p'). That is safe: a
-- guard refusal aborts the whole statement, rolling back everything written
-- here (pinned by deviceOwnershipEpochs.integration.test.ts).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_device_ownership_epoch_advance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  change_cause text := coalesce(nullif(current_setting('breeze.ownership_change_cause', true), ''), 'unspecified');
BEGIN
  IF NEW.org_id IS NOT DISTINCT FROM OLD.org_id THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('breeze.scope', 'system', true);

  IF change_cause NOT IN ('device_move', 'org_merge', 'unspecified') THEN
    RAISE WARNING 'breeze.ownership_change_cause % is not an ownership-change cause; device % epoch % recorded as unspecified',
      change_cause, OLD.id, OLD.ownership_epoch + 1;
  END IF;

  -- Self-heal a departing epoch row that is missing (a device inserted with
  -- user triggers suppressed, e.g. a replica-role restore). A row that exists
  -- under a DIFFERENT org is a real invariant violation: the closure FK below
  -- then fails the move loudly instead of writing false lineage.
  INSERT INTO public.device_ownership_epochs (device_id, epoch, org_id, site_id, cause)
  VALUES (OLD.id, OLD.ownership_epoch, OLD.org_id, OLD.site_id, 'backfill')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.device_ownership_epoch_closures
    (device_id, epoch, org_id, hostname_snapshot, display_name_snapshot, site_id_snapshot)
  VALUES
    (OLD.id, OLD.ownership_epoch, OLD.org_id, OLD.hostname, OLD.display_name, OLD.site_id);

  INSERT INTO public.pam_ledger_retirements (device_id, actuation_id, retired_epoch)
  SELECT OLD.id, a.id, OLD.ownership_epoch
  FROM public.pam_actuations a
  WHERE a.device_id = OLD.id
    AND a.org_id = OLD.org_id
  ON CONFLICT DO NOTHING;

  NEW.ownership_epoch := OLD.ownership_epoch + 1;

  INSERT INTO public.device_ownership_epochs (device_id, epoch, org_id, site_id, cause)
  VALUES (
    NEW.id, NEW.ownership_epoch, NEW.org_id, NEW.site_id,
    CASE WHEN change_cause IN ('device_move', 'org_merge') THEN change_cause ELSE 'unspecified' END
  );

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS devices_ownership_epoch_advance ON public.devices;
CREATE TRIGGER devices_ownership_epoch_advance
  BEFORE UPDATE OF org_id ON public.devices
  FOR EACH ROW
  EXECUTE FUNCTION public.breeze_device_ownership_epoch_advance();

-- The definer bodies are trigger-only; nobody calls them directly.
REVOKE ALL ON FUNCTION public.breeze_device_ownership_epoch_init() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_device_ownership_epoch_advance() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Generic device-move org_id restamp must never touch lineage (it is appended
-- by the trigger above, never rewritten; the tables are also UPDATE-blocked).
-- Body copied VERBATIM from the newest definition,
-- 2026-11-08-170000-fix-memory-tables.sql section 4 (verified with
-- `grep -l 'FUNCTION public.breeze_device_child_orgid_tables' apps/api/migrations/*.sql | sort`
-- — re-run it before committing and re-copy from the newest hit if that
-- changed), with only the three lineage tables added to the NOT IN list.
-- deviceOwnershipEpochs.integration.test.ts pins the full exclusion set.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_device_child_orgid_tables()
  RETURNS SETOF text
  LANGUAGE sql
  STABLE
  AS $$
  SELECT t.relname::text
  FROM pg_class t
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relkind = 'r'
    AND t.relname <> 'devices'
    -- ai_agent_runs: agent-run history stays with the SOURCE org on a device
    -- move (owner decision 2026-08-23); its org_id is trigger-immutable.
    -- PAM lifecycle and result evidence is likewise source-frozen, but unlike
    -- agent runs its existence blocks the device move entirely.
    -- invoice_line_devices: billing evidence stays in its INVOICE's org on a
    -- device move. The invoice and its lines do not move, so restamping the
    -- evidence row's org_id here trips invoice_line_devices_line_org_fk /
    -- invoice_line_devices_invoice_org_fk (DEFERRABLE INITIALLY IMMEDIATE) at
    -- the end of the trigger's own statement. moveOrg.ts detaches device_id
    -- instead, and that statement is LOAD-BEARING, not a mirror of this loop
    -- (#3205 W07).
    -- ai_operator_tasks: AI Operator task history stays with the SOURCE org
    -- (#5205 W03, #5208). org_id is immutable and anchors composite
    -- (x, org_id) FKs, so a re-stamp aborts the move as soon as the task has
    -- an operation, an outbox wake, a target, a step, an event, a linked run
    -- or a linked intent. moveOrg.ts and this trigger both detach device_id
    -- and fence the task instead.
    -- ai_operator_task_targets (recipe library E2): same rule one level down.
    -- The target's org_id is its TASK's org_id and anchors
    -- ai_operator_task_targets_task_org_fk, so re-stamping it to the
    -- destination org while the task stays behind aborts the move with 23503.
    -- Section 9 detaches device_id and stamps the reason instead.
    -- fix_outcomes (AI Suggested Fixes W1): attempt history stays with the org
    -- the attempt ran in; (org_id, partner_id) composite FK would 23503 on a
    -- cross-partner move. The outcome sweeper cancels in-flight rows whose
    -- device left the org.
    -- device_ownership_epochs / device_ownership_epoch_closures: ownership
    -- lineage is append-only; an org change appends a new epoch through
    -- breeze_device_ownership_epoch_advance() instead (PAM ownership epochs
    -- #8203, spec §4). pam_ledger_retirements has no org_id; listed for clarity.
    AND t.relname NOT IN (
      'ai_agent_runs',
      'ai_operator_tasks',
      'ai_operator_task_targets',
      'pam_actuations',
      'pam_actuation_results',
      'invoice_line_devices',
      'offline_transition_effects',
      'fix_outcomes',
      'device_ownership_epochs',
      'device_ownership_epoch_closures',
      'pam_ledger_retirements'
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'device_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    )
    AND EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = t.oid AND a.attname = 'org_id'
        AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype
    );
$$;
