-- Network-isolation containment W1a (#10089, feature #10088, from #4618).
-- Spec: docs/superpowers/specs/security/2026-10-25-network-isolation-containment-spec.md §3.2, §4.
-- Plan: docs/superpowers/plans/security/2026-10-25-network-isolation-containment.md W1a Task 1.
--
-- One row per isolation EPISODE: the server's desired state for a device (desired_state + monotonic
-- generation, release tombstones), the observed state the agent reports (state, mechanism,
-- last_agent_report) and the ordering high-water mark (last_journal_seq). Command delivery stays in
-- device_commands (command_id / release_command_id carry no FK: that table is system-scoped and reaped).
-- Nothing in this file activates isolation: no row is written here, and nothing writes one until the
-- W1b service ships behind NETWORK_ISOLATION_ENABLED (default false).
--
-- Tenancy: RLS shape 1 (direct org_id, breeze_has_org_access), enabled + forced, policies below.
-- org_id NOT NULL by design: an episode is device state, never a template (Partner-Wide First does not
-- apply). Composite FKs to devices / incidents / incident_actions keep the org stamps consistent
-- (RLS alone does not); all three are DEFERRABLE INITIALLY IMMEDIATE so an org merge, which runs
-- SET CONSTRAINTS ALL DEFERRED, can repoint parent and child in separate statements.
--
-- Idempotent; no inner BEGIN/COMMIT; this file writes no rows, so it elects no breeze.scope (the
-- trigger function below elects system scope in-body at run time and restores the caller's).

-- ---------------------------------------------------------------------------
-- Composite-FK targets. incidents and incident_actions had no (id, org_id) key, so an episode could
-- otherwise name another org's incident or action. id is the primary key, so these cannot fail on
-- existing data; they only add the composite key the FKs below need.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'incidents_id_org_uq' AND conrelid = 'incidents'::regclass
  ) THEN
    ALTER TABLE incidents ADD CONSTRAINT incidents_id_org_uq UNIQUE (id, org_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'incident_actions_id_org_uq' AND conrelid = 'incident_actions'::regclass
  ) THEN
    ALTER TABLE incident_actions ADD CONSTRAINT incident_actions_id_org_uq UNIQUE (id, org_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The episode table. The CHECK vocabularies mirror packages/shared/src/utils/networkIsolation.ts;
-- networkIsolation.migration.test.ts compares the two.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_network_isolations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL,
  -- Required at create (the service always links an incident); nullable so deleting the incident
  -- keeps the episode (ON DELETE SET NULL (incident_id) below).
  incident_id uuid,
  incident_action_id uuid,
  -- The server's intent, kept apart from the observed `state` (§3.2).
  desired_state varchar(16) NOT NULL DEFAULT 'isolated',
  state varchar(32) NOT NULL DEFAULT 'requested',
  -- Monotonic. Isolate = 1; every extend and every release tombstone is last + 1; a retransmission of
  -- the same intent keeps it.
  generation integer NOT NULL DEFAULT 1,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Per-episode 256-bit break-glass secret, encrypted under APP_ENCRYPTION_KEY; zeroed when the
  -- episode resolves. Export bucket excludedSensitive.
  break_glass_secret_enc text NOT NULL,
  requested_by_kind varchar(16) NOT NULL,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  dead_man_seconds integer NOT NULL DEFAULT 0,
  remote_relay boolean NOT NULL DEFAULT false,
  mechanism varchar(16),
  -- What was sent: hostnames only, resolved addresses are never stored. Export bucket excludedOpen.
  allow_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The last heartbeat containment report (never carries the secret). Export bucket excludedOpen.
  last_agent_report jsonb,
  failure_code varchar(48),
  release_kind varchar(24),
  command_id uuid,
  release_command_id uuid,
  -- Gate B decision 4(iv): the 12 h expiring-soon alert fires once.
  expiry_warned_at timestamptz,
  -- Gate B decision 4(iv): the journalSeq of the agent's secret_received entry; once set the heartbeat
  -- never carries breakGlassSecret again.
  break_glass_ack_seq bigint,
  -- Gate B decision 4(iv): ordering high-water mark. A report or result whose journalSeq is <= this is
  -- ignored.
  last_journal_seq bigint NOT NULL DEFAULT 0,
  -- Gate B decision 4(iv): the agent confirmed nothing Breeze-owned is installed. Until then a
  -- desired_state = 'released' tombstone stays in the heartbeat.
  release_confirmed_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  applied_at timestamptz,
  verified_at timestamptz,
  release_requested_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT device_network_isolations_device_fk
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  -- Column-list SET NULL (PG15+): a bare SET NULL on a composite FK would null org_id too.
  CONSTRAINT device_network_isolations_incident_fk
    FOREIGN KEY (incident_id, org_id) REFERENCES incidents(id, org_id) ON DELETE SET NULL (incident_id) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT device_network_isolations_incident_action_fk
    FOREIGN KEY (incident_action_id, org_id) REFERENCES incident_actions(id, org_id) ON DELETE SET NULL (incident_action_id) DEFERRABLE INITIALLY IMMEDIATE,

  CONSTRAINT device_network_isolations_desired_state_chk
    CHECK (desired_state IN ('isolated', 'released')),
  CONSTRAINT device_network_isolations_state_chk
    CHECK (state IN ('requested', 'dispatched', 'applying', 'applied', 'verified', 'release_requested', 'released', 'expired', 'failed', 'released_locally', 'self_released', 'uninstalled')),
  CONSTRAINT device_network_isolations_failure_code_chk
    CHECK (failure_code IS NULL OR failure_code IN ('unsupported_platform', 'mechanism_unavailable', 'apply_error', 'control_plane_unreachable', 'enforcement_not_observed', 'not_delivered', 'agent_unsupported')),
  -- A failed episode always says why, and only a failed episode carries a failure code.
  CONSTRAINT device_network_isolations_failed_has_code_chk
    CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  -- The server wants isolation exactly while the episode is isolating; release_requested and every
  -- terminal state carry desired_state = 'released' (a tombstone until release_confirmed_at is set).
  CONSTRAINT device_network_isolations_desired_matches_state_chk
    CHECK ((desired_state = 'isolated') = (state IN ('requested', 'dispatched', 'applying', 'applied', 'verified'))),
  CONSTRAINT device_network_isolations_release_kind_chk
    CHECK (release_kind IS NULL OR release_kind IN ('console', 'ai', 'expired', 'dead_man', 'local_code', 'local_forced', 'uninstall', 'system')),
  CONSTRAINT device_network_isolations_requested_by_kind_chk
    CHECK (requested_by_kind IN ('user', 'brain', 'system')),
  CONSTRAINT device_network_isolations_mechanism_chk
    CHECK (mechanism IS NULL OR mechanism IN ('wfp', 'pf', 'nft')),
  CONSTRAINT device_network_isolations_generation_chk CHECK (generation >= 1),
  CONSTRAINT device_network_isolations_reason_len_chk CHECK (char_length(reason) BETWEEN 1 AND 2000),
  CONSTRAINT device_network_isolations_dead_man_chk CHECK (dead_man_seconds >= 0),
  CONSTRAINT device_network_isolations_journal_seq_chk CHECK (last_journal_seq >= 0),
  CONSTRAINT device_network_isolations_ack_seq_chk CHECK (break_glass_ack_seq IS NULL OR break_glass_ack_seq >= 0),
  CONSTRAINT device_network_isolations_allow_snapshot_chk CHECK (jsonb_typeof(allow_snapshot) = 'array')
);

-- At most one UNRESOLVED episode per device: every active state plus the unacknowledged terminal states
-- (released_locally, self_released). Acknowledging one moves it to `released`, which leaves this index.
CREATE UNIQUE INDEX IF NOT EXISTS device_network_isolations_one_unresolved_uniq
  ON device_network_isolations (device_id)
  WHERE state NOT IN ('released', 'expired', 'failed', 'uninstalled');
CREATE INDEX IF NOT EXISTS device_network_isolations_org_state_idx
  ON device_network_isolations (org_id, state);
-- Expiry sweeper (W1c): active episodes by expiry.
CREATE INDEX IF NOT EXISTS device_network_isolations_active_expiry_idx
  ON device_network_isolations (expires_at)
  WHERE state IN ('requested', 'dispatched', 'applying', 'applied', 'verified', 'release_requested');
-- Heartbeat block builder (W1b): the release tombstone stays until the agent confirms absence.
CREATE INDEX IF NOT EXISTS device_network_isolations_unconfirmed_tombstone_idx
  ON device_network_isolations (device_id)
  WHERE desired_state = 'released' AND release_confirmed_at IS NULL;
-- Per-device history (listEpisodes) and the device FK cascade.
CREATE INDEX IF NOT EXISTS device_network_isolations_device_created_idx
  ON device_network_isolations (device_id, created_at DESC);
-- Incident / action deletes run ON DELETE SET NULL against these.
CREATE INDEX IF NOT EXISTS device_network_isolations_incident_idx
  ON device_network_isolations (incident_id) WHERE incident_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_network_isolations_incident_action_idx
  ON device_network_isolations (incident_action_id) WHERE incident_action_id IS NOT NULL;

ALTER TABLE device_network_isolations ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_network_isolations FORCE ROW LEVEL SECURITY;

-- RLS shape 1: the four standard org-isolation policies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'device_network_isolations' AND policyname = 'breeze_org_isolation_select') THEN
    CREATE POLICY breeze_org_isolation_select ON device_network_isolations
      FOR SELECT USING (breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'device_network_isolations' AND policyname = 'breeze_org_isolation_insert') THEN
    CREATE POLICY breeze_org_isolation_insert ON device_network_isolations
      FOR INSERT WITH CHECK (breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'device_network_isolations' AND policyname = 'breeze_org_isolation_update') THEN
    CREATE POLICY breeze_org_isolation_update ON device_network_isolations
      FOR UPDATE USING (breeze_has_org_access(org_id)) WITH CHECK (breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
      AND tablename = 'device_network_isolations' AND policyname = 'breeze_org_isolation_delete') THEN
    CREATE POLICY breeze_org_isolation_delete ON device_network_isolations
      FOR DELETE USING (breeze_has_org_access(org_id));
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON device_network_isolations TO breeze_app;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Device org move (spec §4 "Ordering", org-move disposition = delete, CORE_DEVICE_ORG_MOVE_DELETE_TABLES).
--
-- An episode names a SOURCE-org incident through (incident_id, org_id). The AFTER UPDATE trigger
-- breeze_cascade_device_org_id() restamps org_id on every device-child table it discovers (this one
-- included), and that restamp would fail device_network_isolations_incident_fk with 23503, aborting the
-- move. The move transaction's own delete loop runs AFTER the devices flip, too late. So, exactly as
-- breeze_topology_presence_device_moved does for topology_device_presence, this BEFORE trigger deletes
-- the device's episode history before the flip, leaving the restamp nothing to touch. audit_logs keep
-- the record.
--
-- Two kinds of row are never deleted; the move is refused instead ("release network isolation first",
-- spec §3.6 item 6):
--  - an UNRESOLVED episode (active, or released_locally / self_released awaiting acknowledgement);
--  - an UNCONFIRMED release tombstone (desired_state = 'released', release_confirmed_at IS NULL), even
--    on a resolved row: failed:not_delivered owes one, because the agent may have applied isolation
--    from the heartbeat's desired state after its command was reaped.
-- Deleting either would leave the device isolated with no release path but expiry or the offline code.
-- The app-level refusal in the move entry point (W1c) gives the operator the friendly error and must use
-- this same definition; this is the backstop for any other writer of devices.org_id.
--
-- Skipped entirely while the source org is fenced for a merge: the merge repoints devices, incidents,
-- incident_actions and these rows to the survivor together under deferred constraints
-- (orgMergeRegistry REPOINT_TABLES), so history survives and nothing is refused here (the merge's own
-- blocker, W1c, refuses a merge with an unresolved episode).
--
-- Writes nothing on devices, so it cannot trip SQLSTATE 27000. SECURITY DEFINER with in-body system
-- scope, saved and restored before RETURN (the table is FORCE RLS and the caller may not see every
-- row); an error aborts the statement, which rolls the set_config back too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_network_isolation_device_moved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = OLD.org_id AND o.status::text = 'merging'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.device_network_isolations i
       WHERE i.device_id = OLD.id
         AND (i.state NOT IN ('released', 'expired', 'failed', 'uninstalled')
              OR (i.desired_state = 'released' AND i.release_confirmed_at IS NULL))
    ) THEN
      PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
      RAISE EXCEPTION 'isolation_unresolved: release network isolation on device % before moving it to another organization', OLD.id
        USING ERRCODE = '55000';
    END IF;
    DELETE FROM public.device_network_isolations WHERE device_id = OLD.id;
  END IF;
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS breeze_network_isolation_device_moved ON public.devices;
CREATE TRIGGER breeze_network_isolation_device_moved
  BEFORE UPDATE OF org_id ON public.devices
  FOR EACH ROW
  WHEN (NEW.org_id IS DISTINCT FROM OLD.org_id)
  EXECUTE FUNCTION public.breeze_network_isolation_device_moved();

-- Trigger-only body; nobody calls it directly.
REVOKE ALL ON FUNCTION public.breeze_network_isolation_device_moved() FROM PUBLIC;
