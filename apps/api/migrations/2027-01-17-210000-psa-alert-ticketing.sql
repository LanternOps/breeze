-- Alert → PSA ticket, W2-A data model (#10499; feature #10528, wave #10535).
--
-- Dark: nothing reads these columns to create tickets until W2-B. Spec
-- docs/superpowers/specs/integrations/2026-10-28-alert-to-psa-ticket-spec.md
-- §3 "W2" and §4; plan W2-A.
--
-- 1. psa_connections gains the partner-level alert ticketing config and its
--    runtime state. The config is user-edited jsonb (validated by the shared
--    per-provider Zod schema, never holding credentials: org sessions can read
--    this row through psa_connections_partner_wide_select). Runtime state is
--    in columns so it never lives in the edited blob: `_rev` is the
--    compare-and-swap counter for PUT, `_enabled_at` the reconciler's lookback
--    floor, `_paused_reason/_paused_at` the auth pause.
-- 2. psa_ticket_mappings becomes the ticket ledger: per-operation states
--    (text + CHECK, never enums, so a later state needs no enum split), lease,
--    attempts and deadlines, the create snapshot. Rows that predate this file
--    take the terminal create_state 'handled' so W2-B never treats them as
--    queued work. A due-time index serves the W2-B worker and reconciler.
-- 3. One mapping per (connection, alert): duplicates are removed (oldest
--    kept, count reported), then a partial unique index.
-- 4. The alert FK becomes ON DELETE CASCADE. alertService's publish rollback
--    and subjectAlertOutbox delete alerts with no pre-clear and would raise
--    23503 once W2 writes mappings. An alert_id index backs the cascade and the
--    alert-page read model.
-- 5. ConnectWise settings.defaultBoardId (API-only; read by a createTicket
--    nothing called) moves into alert_ticketing.boardId, disabled, and is
--    removed from settings. Settings rule 9: the board stays in one place.
-- 6. monitor_definitions.psa_board_id: optional per-monitor PSA board
--    override (#10528 post-approval requirement), read by W2-B admission.
--
-- Tenancy: no new tables and no new org_id column. psa_connections and
-- monitor_definitions keep their dual-axis policies; psa_ticket_mappings keeps
-- its connection-join policy. Export classification is in
-- tenantExportPolicyRegistry.ts.
--
-- Idempotent. Writes rows (the step 3 dedupe and step 5), so system scope first.

SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. psa_connections
-- ---------------------------------------------------------------------------

ALTER TABLE public.psa_connections
  ADD COLUMN IF NOT EXISTS alert_ticketing jsonb,
  ADD COLUMN IF NOT EXISTS alert_ticketing_rev integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS alert_ticketing_enabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS alert_ticketing_paused_reason text,
  ADD COLUMN IF NOT EXISTS alert_ticketing_paused_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_connections_alert_ticketing_object_chk'
       AND conrelid = 'public.psa_connections'::regclass
  ) THEN
    ALTER TABLE public.psa_connections
      ADD CONSTRAINT psa_connections_alert_ticketing_object_chk
      CHECK (alert_ticketing IS NULL OR jsonb_typeof(alert_ticketing) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_connections_alert_ticketing_rev_chk'
       AND conrelid = 'public.psa_connections'::regclass
  ) THEN
    ALTER TABLE public.psa_connections
      ADD CONSTRAINT psa_connections_alert_ticketing_rev_chk
      CHECK (alert_ticketing_rev >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_connections_alert_ticketing_paused_chk'
       AND conrelid = 'public.psa_connections'::regclass
  ) THEN
    ALTER TABLE public.psa_connections
      ADD CONSTRAINT psa_connections_alert_ticketing_paused_chk
      CHECK (
        (alert_ticketing_paused_reason IS NULL) = (alert_ticketing_paused_at IS NULL)
        AND (alert_ticketing_paused_reason IS NULL OR alert_ticketing_paused_reason IN ('auth'))
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. psa_ticket_mappings ledger columns
-- ---------------------------------------------------------------------------

-- create_state is added with the terminal default 'handled' so every
-- pre-existing row is closed out, then the default for new rows becomes
-- 'never_attempted'. Re-running is a no-op (ADD COLUMN IF NOT EXISTS).
ALTER TABLE public.psa_ticket_mappings
  ADD COLUMN IF NOT EXISTS create_state text NOT NULL DEFAULT 'handled';
ALTER TABLE public.psa_ticket_mappings
  ALTER COLUMN create_state SET DEFAULT 'never_attempted';

ALTER TABLE public.psa_ticket_mappings
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS config_rev integer,
  ADD COLUMN IF NOT EXISTS close_state text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS note_state text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS last_error_class text,
  ADD COLUMN IF NOT EXISTS create_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS external_company_id varchar(100),
  ADD COLUMN IF NOT EXISTS external_ticket_number varchar(100),
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

-- Vocabulary (W2-B owns the transitions):
--   create_state  never_attempted → create_in_flight → created
--                 | create_outcome_unknown (lookup by marker; never re-POST)
--                 | rejected | failed | needs_attention (human: create anyway /
--                 mark handled → handled) | skipped_no_company
--                 | skipped_ambiguous_company | skipped_resolved_before_create
--   close_state   the resolve operation (close, or a resolve note when
--                 closeOnResolve is off): none → pending → in_flight → closed
--                 | outcome_unknown | failed
--   note_state    the acknowledgement note, at most once per mapping:
--                 none → pending → in_flight → posted | outcome_unknown | failed
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_ticket_mappings_source_chk'
       AND conrelid = 'public.psa_ticket_mappings'::regclass
  ) THEN
    ALTER TABLE public.psa_ticket_mappings
      ADD CONSTRAINT psa_ticket_mappings_source_chk CHECK (source IN ('auto', 'manual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_ticket_mappings_create_state_chk'
       AND conrelid = 'public.psa_ticket_mappings'::regclass
  ) THEN
    ALTER TABLE public.psa_ticket_mappings
      ADD CONSTRAINT psa_ticket_mappings_create_state_chk CHECK (create_state IN (
        'never_attempted', 'create_in_flight', 'created', 'create_outcome_unknown',
        'rejected', 'failed', 'needs_attention', 'handled',
        'skipped_no_company', 'skipped_ambiguous_company', 'skipped_resolved_before_create'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_ticket_mappings_close_state_chk'
       AND conrelid = 'public.psa_ticket_mappings'::regclass
  ) THEN
    ALTER TABLE public.psa_ticket_mappings
      ADD CONSTRAINT psa_ticket_mappings_close_state_chk CHECK (close_state IN (
        'none', 'pending', 'in_flight', 'closed', 'outcome_unknown', 'failed'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_ticket_mappings_note_state_chk'
       AND conrelid = 'public.psa_ticket_mappings'::regclass
  ) THEN
    ALTER TABLE public.psa_ticket_mappings
      ADD CONSTRAINT psa_ticket_mappings_note_state_chk CHECK (note_state IN (
        'none', 'pending', 'in_flight', 'posted', 'outcome_unknown', 'failed'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_ticket_mappings_last_error_class_chk'
       AND conrelid = 'public.psa_ticket_mappings'::regclass
  ) THEN
    ALTER TABLE public.psa_ticket_mappings
      ADD CONSTRAINT psa_ticket_mappings_last_error_class_chk CHECK (
        last_error_class IS NULL
        OR last_error_class IN ('auth', 'rate_limited', 'transient', 'rejected', 'unknown_outcome')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_ticket_mappings_attempts_chk'
       AND conrelid = 'public.psa_ticket_mappings'::regclass
  ) THEN
    ALTER TABLE public.psa_ticket_mappings
      ADD CONSTRAINT psa_ticket_mappings_attempts_chk CHECK (attempts >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_ticket_mappings_lease_chk'
       AND conrelid = 'public.psa_ticket_mappings'::regclass
  ) THEN
    ALTER TABLE public.psa_ticket_mappings
      ADD CONSTRAINT psa_ticket_mappings_lease_chk CHECK ((lease_token IS NULL) = (lease_until IS NULL));
  END IF;

  -- A mapping that claims a created ticket must say which one. Pre-existing
  -- rows are 'handled', never 'created', so this validates without a scan hit.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_ticket_mappings_created_ticket_chk'
       AND conrelid = 'public.psa_ticket_mappings'::regclass
  ) THEN
    ALTER TABLE public.psa_ticket_mappings
      ADD CONSTRAINT psa_ticket_mappings_created_ticket_chk
      CHECK (create_state <> 'created' OR external_ticket_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_ticket_mappings_create_snapshot_object_chk'
       AND conrelid = 'public.psa_ticket_mappings'::regclass
  ) THEN
    ALTER TABLE public.psa_ticket_mappings
      ADD CONSTRAINT psa_ticket_mappings_create_snapshot_object_chk
      CHECK (create_snapshot IS NULL OR jsonb_typeof(create_snapshot) = 'object');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. One mapping per (connection, alert)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.psa_ticket_mappings m
   USING public.psa_ticket_mappings keep
   WHERE m.alert_id IS NOT NULL
     AND keep.connection_id = m.connection_id
     AND keep.alert_id = m.alert_id
     AND (keep.created_at, keep.id) < (m.created_at, m.id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed > 0 THEN
    RAISE WARNING 'psa-alert-ticketing: removed % duplicate psa_ticket_mappings rows per (connection_id, alert_id), kept the oldest', removed;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS psa_ticket_mappings_connection_alert_uq
  ON public.psa_ticket_mappings (connection_id, alert_id)
  WHERE alert_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. alert FK → ON DELETE CASCADE, plus the index the cascade scans
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS psa_ticket_mappings_alert_idx
  ON public.psa_ticket_mappings (alert_id)
  WHERE alert_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'psa_ticket_mappings_alert_id_alerts_id_fk'
       AND conrelid = 'public.psa_ticket_mappings'::regclass
       AND confdeltype = 'c'
  ) THEN
    ALTER TABLE public.psa_ticket_mappings
      DROP CONSTRAINT IF EXISTS psa_ticket_mappings_alert_id_alerts_id_fk;
    ALTER TABLE public.psa_ticket_mappings
      ADD CONSTRAINT psa_ticket_mappings_alert_id_alerts_id_fk
      FOREIGN KEY (alert_id) REFERENCES public.alerts(id) ON DELETE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4b. Due-time index: work the W2-B worker and reconciler pick up
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS psa_ticket_mappings_due_idx
  ON public.psa_ticket_mappings (next_attempt_at)
  WHERE create_state IN ('never_attempted', 'create_in_flight', 'create_outcome_unknown')
     OR close_state IN ('pending', 'in_flight', 'outcome_unknown')
     OR note_state IN ('pending', 'in_flight', 'outcome_unknown');

-- ---------------------------------------------------------------------------
-- 5. settings.defaultBoardId → alert_ticketing.boardId (ConnectWise only)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  moved integer;
  dropped integer;
BEGIN
  UPDATE public.psa_connections
     SET alert_ticketing = jsonb_build_object(
           'enabled', false,
           'boardId', (settings->>'defaultBoardId')::integer
         ),
         settings = settings - 'defaultBoardId',
         updated_at = now()
   WHERE provider = 'connectwise'
     AND alert_ticketing IS NULL
     AND jsonb_typeof(settings) = 'object'
     AND settings ? 'defaultBoardId'
     AND jsonb_typeof(settings->'defaultBoardId') IN ('number', 'string')
     AND (settings->>'defaultBoardId') ~ '^[1-9][0-9]{0,8}$';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved > 0 THEN
    RAISE WARNING 'psa-alert-ticketing: moved settings.defaultBoardId into alert_ticketing.boardId (disabled) on % ConnectWise connections', moved;
  END IF;

  -- Whatever is left is not a usable board id (or the connection already had
  -- alert_ticketing): drop the dead key so the board has one home.
  UPDATE public.psa_connections
     SET settings = settings - 'defaultBoardId',
         updated_at = now()
   WHERE provider = 'connectwise'
     AND jsonb_typeof(settings) = 'object'
     AND settings ? 'defaultBoardId';
  GET DIAGNOSTICS dropped = ROW_COUNT;
  IF dropped > 0 THEN
    RAISE WARNING 'psa-alert-ticketing: removed an unusable settings.defaultBoardId from % ConnectWise connections', dropped;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. monitor_definitions.psa_board_id
-- ---------------------------------------------------------------------------

-- The PSA board (ConnectWise board id) this monitor's alert tickets go to,
-- overriding the bound connection's alert_ticketing.boardId. NULL = use the
-- connection default. Set only by partner admins who can manage partner-wide
-- config (route gate); nothing reads it until W2-B.
ALTER TABLE public.monitor_definitions
  ADD COLUMN IF NOT EXISTS psa_board_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'monitor_definitions_psa_board_id_chk'
       AND conrelid = 'public.monitor_definitions'::regclass
  ) THEN
    ALTER TABLE public.monitor_definitions
      ADD CONSTRAINT monitor_definitions_psa_board_id_chk CHECK (psa_board_id IS NULL OR psa_board_id > 0);
  END IF;
END $$;
