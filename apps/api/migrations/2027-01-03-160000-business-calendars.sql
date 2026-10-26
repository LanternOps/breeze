-- #8973 W4 (#9784): business-hours calendars.
-- Spec: docs/superpowers/specs/ticketing/2026-10-18-ticketing-merge-sla-calendars-routing-spec.md §4.1, §4.2, §4.6 step 2, §8.1.
-- Plan: docs/superpowers/plans/ticketing/2026-10-22-ticketing-merge-sla-calendars-routing.md Task 4.1.
--
-- Tenancy shape: business_calendars is a CONFIG table (an MSP defines one set
-- of hours and every org inherits it), so it follows "Partner-Wide First":
-- org_id XOR partner_id (business_calendars_one_owner_chk), ONE dual-axis
-- FOR ALL policy and a SEPARATE additive FOR SELECT partner-wide branch keyed
-- on breeze_current_partner_id() (template 2027-01-02-130000-flows.sql). The
-- branch is never appended to the FOR ALL policy, so an org token can READ a
-- partner-wide calendar but its UPDATE/DELETE matches 0 rows. A second
-- SELECT-only branch (<table>_org_member_select) covers organization sessions,
-- whose JWT carries no partner id: see section 7.
--
-- The three children (revisions, intervals, holidays) DENORMALISE the owner
-- pair from their parent, like tool_source_tools: each carries the same policy
-- pair, and an owner-guard CONSTRAINT trigger (DEFERRABLE INITIALLY IMMEDIATE,
-- so org merge can repoint parent and child in separate statements under
-- SET CONSTRAINTS ALL DEFERRED) keeps child owner == parent owner. Children
-- reference parents by plain id FK (partner rows have org_id NULL), so no
-- composite (x, org_id) FK exists and none needs DEFERRABLE.
--
-- Revisions are immutable on UPDATE (the hours a ticket snapshotted must never
-- change under it) except created_by_user_id -> NULL (FK SET NULL) and an
-- org_id-only ownership restamp (org merge, Gate B15). Intervals belong to a
-- revision, so they get the same rule (org_id only). DELETE stays granted, so
-- tenant erasure needs no AUDIT_ADMIN_REQUIRED_TABLES entry.
--
-- No jsonb anywhere: every column is export-policy `included`.
--
-- org_ticket_settings.business_calendar_id is the org override (spec §4.2);
-- FK ON DELETE SET NULL (the service refuses deleting a calendar in use), and
-- a same-partner trigger refuses another org's or another partner's calendar.
--
-- The tickets.sla_calendar_revision_id column is NOT here: hot-table DDL on
-- tickets lives in its own -- @no-transaction file (2027-01-03-160100).
--
-- Last, a one-time backfill (spec §4.6 step 2, Gate B5) turns each partner's
-- stored partners.settings.businessHours preset into a NON-default partner
-- calendar named 'Business hours (imported)'. Nothing changes for any ticket
-- until a partner marks a calendar as default. partners.settings is not
-- rewritten. Time zone: partners.settings.timezone when it names a zone in
-- pg_timezone_names, else 'UTC' (counted in a NOTICE).
--
-- Idempotent (IF NOT EXISTS / DO $$ guards / DROP … IF EXISTS + CREATE; the
-- backfill is INSERT … WHERE NOT EXISTS keyed on (partner_id, name)). No
-- inner BEGIN/COMMIT. The backfill writes rows, so system scope is elected
-- right before it (#4518 guard); the DDL above it writes none.

-- ============================================
-- 1. business_calendars
-- ============================================
CREATE TABLE IF NOT EXISTS business_calendars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  is_partner_default boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_calendars_one_owner_chk' AND conrelid = 'business_calendars'::regclass) THEN
    ALTER TABLE business_calendars ADD CONSTRAINT business_calendars_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_calendars_name_chk' AND conrelid = 'business_calendars'::regclass) THEN
    ALTER TABLE business_calendars ADD CONSTRAINT business_calendars_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 100);
  END IF;
  -- Only a partner-wide calendar can be the partner default, and a default
  -- can never be archived (spec §4.1).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_calendars_default_chk' AND conrelid = 'business_calendars'::regclass) THEN
    ALTER TABLE business_calendars ADD CONSTRAINT business_calendars_default_chk
      CHECK (NOT is_partner_default OR (org_id IS NULL AND archived_at IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS business_calendars_partner_idx ON business_calendars (partner_id) WHERE org_id IS NULL;
CREATE INDEX IF NOT EXISTS business_calendars_org_idx ON business_calendars (org_id) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS business_calendars_partner_default_uq
  ON business_calendars (partner_id) WHERE is_partner_default AND org_id IS NULL;
-- Partner-axis only. No org-axis name unique on purpose: org merge repoints
-- org-owned calendars, and two orgs with a same-named calendar would 23505.
CREATE UNIQUE INDEX IF NOT EXISTS business_calendars_partner_name_uq
  ON business_calendars (partner_id, name) WHERE org_id IS NULL;

-- ============================================
-- 2. business_calendar_revisions
-- ============================================
CREATE TABLE IF NOT EXISTS business_calendar_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id uuid NOT NULL REFERENCES business_calendars(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  timezone varchar(64) NOT NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_calendar_revisions_one_owner_chk' AND conrelid = 'business_calendar_revisions'::regclass) THEN
    ALTER TABLE business_calendar_revisions ADD CONSTRAINT business_calendar_revisions_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_calendar_revisions_revision_chk' AND conrelid = 'business_calendar_revisions'::regclass) THEN
    ALTER TABLE business_calendar_revisions ADD CONSTRAINT business_calendar_revisions_revision_chk CHECK (revision >= 1);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS business_calendar_revisions_calendar_revision_uq
  ON business_calendar_revisions (calendar_id, revision);
CREATE INDEX IF NOT EXISTS business_calendar_revisions_org_idx ON business_calendar_revisions (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS business_calendar_revisions_partner_idx ON business_calendar_revisions (partner_id) WHERE org_id IS NULL;

-- ============================================
-- 3. business_calendar_intervals
-- ============================================
-- weekday 0 = Sunday … 6 = Saturday (packages/shared/src/utils/businessTime.ts).
CREATE TABLE IF NOT EXISTS business_calendar_intervals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES business_calendar_revisions(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  weekday smallint NOT NULL,
  start_minute smallint NOT NULL,
  end_minute smallint NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_calendar_intervals_one_owner_chk' AND conrelid = 'business_calendar_intervals'::regclass) THEN
    ALTER TABLE business_calendar_intervals ADD CONSTRAINT business_calendar_intervals_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_calendar_intervals_range_chk' AND conrelid = 'business_calendar_intervals'::regclass) THEN
    ALTER TABLE business_calendar_intervals ADD CONSTRAINT business_calendar_intervals_range_chk CHECK (
      weekday BETWEEN 0 AND 6
      AND start_minute BETWEEN 0 AND 1439
      AND end_minute BETWEEN 1 AND 1440
      AND start_minute < end_minute
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS business_calendar_intervals_revision_idx ON business_calendar_intervals (revision_id, weekday, start_minute);
CREATE INDEX IF NOT EXISTS business_calendar_intervals_org_idx ON business_calendar_intervals (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS business_calendar_intervals_partner_idx ON business_calendar_intervals (partner_id) WHERE org_id IS NULL;

-- ============================================
-- 4. business_calendar_holidays
-- ============================================
CREATE TABLE IF NOT EXISTS business_calendar_holidays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id uuid NOT NULL REFERENCES business_calendars(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  holiday_date date NOT NULL,
  name varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_calendar_holidays_one_owner_chk' AND conrelid = 'business_calendar_holidays'::regclass) THEN
    ALTER TABLE business_calendar_holidays ADD CONSTRAINT business_calendar_holidays_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_calendar_holidays_name_chk' AND conrelid = 'business_calendar_holidays'::regclass) THEN
    ALTER TABLE business_calendar_holidays ADD CONSTRAINT business_calendar_holidays_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 100);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS business_calendar_holidays_calendar_date_uq
  ON business_calendar_holidays (calendar_id, holiday_date);
CREATE INDEX IF NOT EXISTS business_calendar_holidays_org_idx ON business_calendar_holidays (org_id) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS business_calendar_holidays_partner_idx ON business_calendar_holidays (partner_id) WHERE org_id IS NULL;

-- ============================================
-- 5. Owner guards (child owner == parent owner)
-- ============================================
-- CONSTRAINT triggers, DEFERRABLE INITIALLY IMMEDIATE: org merge runs
-- SET CONSTRAINTS ALL DEFERRED and repoints parent and child in separate
-- statements. ERRCODE check_violation (23514) with a *_parent_owner_chk name,
-- so callers see the same shape as a CHECK.
CREATE OR REPLACE FUNCTION public.business_calendar_revisions_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_org_id uuid;
  parent_partner_id uuid;
BEGIN
  SELECT c.org_id, c.partner_id INTO parent_org_id, parent_partner_id
    FROM public.business_calendars AS c
   WHERE c.id = NEW.calendar_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "business_calendar_revisions" violates foreign key constraint "business_calendar_revisions_calendar_id_fkey"'
      USING ERRCODE = '23503', CONSTRAINT = 'business_calendar_revisions_calendar_id_fkey';
  END IF;
  IF NEW.org_id IS DISTINCT FROM parent_org_id OR NEW.partner_id IS DISTINCT FROM parent_partner_id THEN
    RAISE EXCEPTION 'business calendar revision owner differs from its calendar owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'business_calendar_revisions_parent_owner_chk';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_calendar_revisions_owner_guard_trg ON business_calendar_revisions;
CREATE CONSTRAINT TRIGGER business_calendar_revisions_owner_guard_trg
  AFTER INSERT OR UPDATE OF calendar_id, org_id, partner_id ON business_calendar_revisions
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.business_calendar_revisions_owner_guard();

CREATE OR REPLACE FUNCTION public.business_calendar_intervals_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_org_id uuid;
  parent_partner_id uuid;
BEGIN
  SELECT r.org_id, r.partner_id INTO parent_org_id, parent_partner_id
    FROM public.business_calendar_revisions AS r
   WHERE r.id = NEW.revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "business_calendar_intervals" violates foreign key constraint "business_calendar_intervals_revision_id_fkey"'
      USING ERRCODE = '23503', CONSTRAINT = 'business_calendar_intervals_revision_id_fkey';
  END IF;
  IF NEW.org_id IS DISTINCT FROM parent_org_id OR NEW.partner_id IS DISTINCT FROM parent_partner_id THEN
    RAISE EXCEPTION 'business calendar interval owner differs from its revision owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'business_calendar_intervals_parent_owner_chk';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_calendar_intervals_owner_guard_trg ON business_calendar_intervals;
CREATE CONSTRAINT TRIGGER business_calendar_intervals_owner_guard_trg
  AFTER INSERT OR UPDATE OF revision_id, org_id, partner_id ON business_calendar_intervals
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.business_calendar_intervals_owner_guard();

CREATE OR REPLACE FUNCTION public.business_calendar_holidays_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_org_id uuid;
  parent_partner_id uuid;
BEGIN
  SELECT c.org_id, c.partner_id INTO parent_org_id, parent_partner_id
    FROM public.business_calendars AS c
   WHERE c.id = NEW.calendar_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "business_calendar_holidays" violates foreign key constraint "business_calendar_holidays_calendar_id_fkey"'
      USING ERRCODE = '23503', CONSTRAINT = 'business_calendar_holidays_calendar_id_fkey';
  END IF;
  IF NEW.org_id IS DISTINCT FROM parent_org_id OR NEW.partner_id IS DISTINCT FROM parent_partner_id THEN
    RAISE EXCEPTION 'business calendar holiday owner differs from its calendar owner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'business_calendar_holidays_parent_owner_chk';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_calendar_holidays_owner_guard_trg ON business_calendar_holidays;
CREATE CONSTRAINT TRIGGER business_calendar_holidays_owner_guard_trg
  AFTER INSERT OR UPDATE OF calendar_id, org_id, partner_id ON business_calendar_holidays
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.business_calendar_holidays_owner_guard();

-- ============================================
-- 6. Revision validity: time zone, immutability, interval overlap
-- ============================================
-- timezone must be an IANA name Postgres knows (the service validates the
-- same rule with isValidIanaTimezone first). pg_timezone_names cannot appear
-- in a CHECK, so a BEFORE INSERT trigger; UPDATE is covered by immutability.
CREATE OR REPLACE FUNCTION public.business_calendar_revisions_timezone_chk()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'business calendar revision time zone "%" is not a known IANA zone', NEW.timezone
      USING ERRCODE = 'check_violation', CONSTRAINT = 'business_calendar_revisions_timezone_chk';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_calendar_revisions_timezone_chk ON business_calendar_revisions;
CREATE TRIGGER business_calendar_revisions_timezone_chk
  BEFORE INSERT ON business_calendar_revisions
  FOR EACH ROW EXECUTE FUNCTION public.business_calendar_revisions_timezone_chk();

-- A revision is a snapshot: only created_by_user_id -> NULL (FK SET NULL) and
-- an org_id-only restamp (org merge, Gate B15; partner_id is not exempt, so
-- ownership can never change axis) are allowed. Same shape as
-- ticket_approval_requests_decided_immutable (2026-12-20-200200).
CREATE OR REPLACE FUNCTION public.business_calendar_revisions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  exempt text[] := ARRAY['org_id', 'created_by_user_id'];
BEGIN
  IF (to_jsonb(NEW) - exempt) IS DISTINCT FROM (to_jsonb(OLD) - exempt)
     OR (NEW.created_by_user_id IS NOT NULL
         AND NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'business calendar revision is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_calendar_revisions_immutable ON business_calendar_revisions;
CREATE TRIGGER business_calendar_revisions_immutable
  BEFORE UPDATE ON business_calendar_revisions
  FOR EACH ROW EXECUTE FUNCTION public.business_calendar_revisions_immutable();

-- An interval is part of its revision's snapshot: org_id-only restamp allowed.
CREATE OR REPLACE FUNCTION public.business_calendar_intervals_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'org_id') IS DISTINCT FROM (to_jsonb(OLD) - 'org_id') THEN
    RAISE EXCEPTION 'business calendar interval is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_calendar_intervals_immutable ON business_calendar_intervals;
CREATE TRIGGER business_calendar_intervals_immutable
  BEFORE UPDATE ON business_calendar_intervals
  FOR EACH ROW EXECUTE FUNCTION public.business_calendar_intervals_immutable();

-- Overlap backstop (the service refuses overlaps first, via validateRevision).
-- No EXCLUDE constraint: it would need btree_gist, which a self-hosted role
-- may not be able to create (spec §4.1). Half-open ranges, so 09:00–12:00 and
-- 12:00–17:00 on the same day do not overlap.
CREATE OR REPLACE FUNCTION public.business_calendar_intervals_no_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.business_calendar_intervals AS i
     WHERE i.revision_id = NEW.revision_id
       AND i.weekday = NEW.weekday
       AND i.id <> NEW.id
       AND i.start_minute < NEW.end_minute
       AND NEW.start_minute < i.end_minute
  ) THEN
    RAISE EXCEPTION 'business calendar intervals overlap on weekday %', NEW.weekday
      USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'business_calendar_intervals_no_overlap';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS business_calendar_intervals_no_overlap_trg ON business_calendar_intervals;
CREATE CONSTRAINT TRIGGER business_calendar_intervals_no_overlap_trg
  AFTER INSERT OR UPDATE OF revision_id, weekday, start_minute, end_minute ON business_calendar_intervals
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.business_calendar_intervals_no_overlap();

-- ============================================
-- 7. RLS — one dual-axis FOR ALL policy per table, plus the additive
--    SELECT-only own-partner read branch (tenancy-rls.md step 3).
-- ============================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_calendars', 'business_calendar_revisions', 'business_calendar_intervals', 'business_calendar_holidays']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I
        USING (
          public.breeze_current_scope() = 'system'
          OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
          OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
        )
        WITH CHECK (
          public.breeze_current_scope() = 'system'
          OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
          OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
        )
    $p$, t || '_isolation', t);
    -- `=` and not IS NOT DISTINCT FROM: an unset GUC reads NULL and must never match.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_partner_wide_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())',
      t || '_partner_wide_select', t
    );
    -- Org-member read branch, also SELECT-only. Organization-session JWTs
    -- deliberately carry partnerId = NULL (middleware/auth.ts), so for an org
    -- user breeze_current_partner_id() is NULL and the branch above never
    -- matches; without this, an org user's ticket would silently resolve to
    -- 24×7 and every SLA write on a partner-default ticket (first response,
    -- pause end) would fail to read its snapshot. A partner-wide calendar is
    -- readable by a session with access to an org of THAT partner — the read
    -- the branch above intends, derived from org access instead of a claim.
    -- The organizations read inside runs under the caller's own RLS.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_org_member_select', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I FOR SELECT USING (
        org_id IS NULL
        AND EXISTS (
          SELECT 1 FROM public.organizations o
           WHERE o.partner_id = %I.partner_id
             AND public.breeze_has_org_access(o.id)
        )
      )
    $p$, t || '_org_member_select', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO breeze_app', t);
  END LOOP;
END $$;

-- ============================================
-- 8. org_ticket_settings.business_calendar_id (org override, spec §4.2)
-- ============================================
ALTER TABLE org_ticket_settings ADD COLUMN IF NOT EXISTS business_calendar_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_ticket_settings_business_calendar_id_fk' AND conrelid = 'org_ticket_settings'::regclass) THEN
    ALTER TABLE org_ticket_settings
      ADD CONSTRAINT org_ticket_settings_business_calendar_id_fk
      FOREIGN KEY (business_calendar_id) REFERENCES business_calendars(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS org_ticket_settings_business_calendar_idx
  ON org_ticket_settings (business_calendar_id) WHERE business_calendar_id IS NOT NULL;

-- An org-owned calendar is selectable only by its own org; a partner-wide one
-- only by that partner's orgs (spec §4.1). Reads under the caller's RLS: a
-- calendar the caller cannot see is refused as missing. Deferrable so org
-- merge, which defers all constraints, checks the final state.
CREATE OR REPLACE FUNCTION public.org_ticket_settings_business_calendar_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  cal_org_id uuid;
  cal_partner_id uuid;
  org_partner_id uuid;
BEGIN
  IF NEW.business_calendar_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT c.org_id, c.partner_id INTO cal_org_id, cal_partner_id
    FROM public.business_calendars AS c
   WHERE c.id = NEW.business_calendar_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "org_ticket_settings" violates foreign key constraint "org_ticket_settings_business_calendar_id_fk"'
      USING ERRCODE = '23503', CONSTRAINT = 'org_ticket_settings_business_calendar_id_fk';
  END IF;
  SELECT o.partner_id INTO org_partner_id FROM public.organizations AS o WHERE o.id = NEW.org_id;
  IF (cal_org_id IS NOT NULL AND cal_org_id IS DISTINCT FROM NEW.org_id)
     OR (cal_partner_id IS NOT NULL AND cal_partner_id IS DISTINCT FROM org_partner_id) THEN
    RAISE EXCEPTION 'business calendar % does not belong to this organization or its partner', NEW.business_calendar_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_ticket_settings_business_calendar_owner_chk';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS org_ticket_settings_business_calendar_guard_trg ON org_ticket_settings;
CREATE CONSTRAINT TRIGGER org_ticket_settings_business_calendar_guard_trg
  AFTER INSERT OR UPDATE OF business_calendar_id, org_id ON org_ticket_settings
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.org_ticket_settings_business_calendar_guard();

-- ============================================
-- 9. Backfill: partners.settings.businessHours -> a non-default calendar
-- ============================================
-- Presets (the en locale copy of the retired Regional card):
--   business  Mon–Fri 09:00–17:00
--   extended  Mon–Fri 07:00–19:00 + Sat 09:00–13:00
--   custom    mon…sun {start 'HH:MM', end 'HH:MM', closed?}; a missing day
--             key is closed
--   24/7, or no businessHours key -> no calendar (24×7 is the null calendar).
-- Malformed (no calendar, counted in a WARNING): businessHours not an object,
-- an unknown preset, custom without a schedule object, an unknown day key, a
-- day value that is not an object, an unparsable time on an open day,
-- start >= end on an open day, or no open interval at all.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  p record;
  bh jsonb;
  preset text;
  sched jsonb;
  day_key text;
  day_val jsonb;
  wd smallint;
  s text;
  e text;
  s_min int;
  e_min int;
  ivals int[][];
  bad boolean;
  tz text;
  cal_id uuid;
  rev_id uuid;
  created_count int := 0;
  malformed_count int := 0;
  tz_fallback_count int := 0;
  time_re constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
BEGIN
  FOR p IN
    SELECT id, settings
      FROM public.partners
     WHERE deleted_at IS NULL
       AND settings IS NOT NULL
       AND jsonb_typeof(settings) = 'object'
       AND settings ? 'businessHours'
     ORDER BY id
  LOOP
    bh := p.settings -> 'businessHours';
    IF jsonb_typeof(bh) <> 'object' THEN
      malformed_count := malformed_count + 1;
      CONTINUE;
    END IF;
    preset := bh ->> 'preset';
    IF preset = '24/7' THEN
      CONTINUE;
    END IF;

    ivals := ARRAY[]::int[][];
    bad := false;
    IF preset = 'business' THEN
      ivals := ARRAY[[1, 540, 1020], [2, 540, 1020], [3, 540, 1020], [4, 540, 1020], [5, 540, 1020]];
    ELSIF preset = 'extended' THEN
      ivals := ARRAY[[1, 420, 1140], [2, 420, 1140], [3, 420, 1140], [4, 420, 1140], [5, 420, 1140], [6, 540, 780]];
    ELSIF preset = 'custom' THEN
      sched := bh -> 'custom';
      IF sched IS NULL OR jsonb_typeof(sched) <> 'object' THEN
        bad := true;
      ELSE
        FOR day_key, day_val IN SELECT key, value FROM jsonb_each(sched) LOOP
          wd := CASE day_key
            WHEN 'sun' THEN 0 WHEN 'mon' THEN 1 WHEN 'tue' THEN 2 WHEN 'wed' THEN 3
            WHEN 'thu' THEN 4 WHEN 'fri' THEN 5 WHEN 'sat' THEN 6 ELSE NULL END;
          IF wd IS NULL OR jsonb_typeof(day_val) <> 'object' THEN
            bad := true;
            EXIT;
          END IF;
          IF (day_val -> 'closed') = 'true'::jsonb THEN
            CONTINUE;
          END IF;
          s := day_val ->> 'start';
          e := day_val ->> 'end';
          IF s IS NULL OR e IS NULL OR s !~ time_re OR (e !~ time_re AND e <> '24:00') THEN
            bad := true;
            EXIT;
          END IF;
          s_min := split_part(s, ':', 1)::int * 60 + split_part(s, ':', 2)::int;
          e_min := split_part(e, ':', 1)::int * 60 + split_part(e, ':', 2)::int;
          IF s_min >= e_min THEN
            bad := true;
            EXIT;
          END IF;
          ivals := ivals || ARRAY[[wd::int, s_min, e_min]];
        END LOOP;
        IF NOT bad AND coalesce(array_length(ivals, 1), 0) = 0 THEN
          bad := true;
        END IF;
      END IF;
    ELSE
      bad := true;
    END IF;

    IF bad THEN
      malformed_count := malformed_count + 1;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.business_calendars
       WHERE partner_id = p.id AND org_id IS NULL AND name = 'Business hours (imported)'
    ) THEN
      CONTINUE;
    END IF;

    tz := p.settings ->> 'timezone';
    IF tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = tz) THEN
      tz := 'UTC';
      tz_fallback_count := tz_fallback_count + 1;
    END IF;

    INSERT INTO public.business_calendars (partner_id, org_id, name, is_partner_default)
    VALUES (p.id, NULL, 'Business hours (imported)', false)
    RETURNING id INTO cal_id;

    INSERT INTO public.business_calendar_revisions (calendar_id, partner_id, org_id, revision, timezone)
    VALUES (cal_id, p.id, NULL, 1, tz)
    RETURNING id INTO rev_id;

    INSERT INTO public.business_calendar_intervals (revision_id, partner_id, org_id, weekday, start_minute, end_minute)
    SELECT rev_id, p.id, NULL, ivals[i][1], ivals[i][2], ivals[i][3]
      FROM generate_subscripts(ivals, 1) AS i;

    created_count := created_count + 1;
  END LOOP;

  RAISE NOTICE 'imported % business-hours blobs as non-default calendars', created_count;
  IF tz_fallback_count > 0 THEN
    RAISE NOTICE 'used UTC for % imported calendars whose partner time zone was missing or unknown', tz_fallback_count;
  END IF;
  IF malformed_count > 0 THEN
    RAISE WARNING 'skipped % malformed business-hours blobs', malformed_count;
  END IF;
END $$;
