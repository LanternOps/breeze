-- 2026-10-11-160000-device-custom-field-values.sql   (#3257 W05)
--
-- DEVICE CUSTOM-FIELD VALUES BECOME A REAL TABLE.
--
-- `devices.custom_fields` survives as a TRIGGER-MAINTAINED PROJECTION (Open
-- Decision 1 = A, approved at Gate A), so the ~34 JS readers, the MCP
-- SAFE_DEVICE_RESOURCE_FIELDS projection and BOTH partner-export statement
-- triggers keep working unchanged. Only three SQL consumers are rewritten.
--
-- FOUR THINGS THIS CLOSES, all live defects today:
--   1. The partner export emits TWO records for ONE datum when an org-owned and
--      a partner-wide definition share a field_key, because the identity hash
--      includes f.id (routes/partnerApi/configuration.ts). W03's anti-shadowing
--      trigger forbids NEW ones; this removes the shape entirely by making the
--      ROW the datum, bounded by UNIQUE (device_id, definition_id).
--   2. devices.custom_fields is `excludedOpen` in CORE_TENANT_EXPORT_POLICY
--      (every json/jsonb column must be), so every custom-field value was
--      silently DROPPED from the GDPR tenant export. Normalized scalar columns
--      can be `included`.
--   3. custom.<key> filters scanned with jsonb_extract_path_text and no index.
--   4. Deleting a definition orphaned every value stored under it, forever.
--
-- TENANCY: RLS shape 5 (device-id scoped, hot, DENORMALIZED org_id) — a direct
-- breeze_has_org_access(org_id) policy, not an EXISTS join. A direct-org_id
-- policy TRUSTS org_id, so TWO coherence guards sit under it:
--   * a composite FK (device_id, org_id) -> devices(id, org_id), and
--   * a trigger for definition_id, which is DUAL-AXIS (org XOR partner, W02)
--     and therefore not expressible as any single FK.
--
-- WHY THE SCOPE ELEVATION ON A FILE THAT WRITES ROWS *AND* ON THE TRIGGER.
-- devices, organizations and custom_field_definitions are all FORCE ROW LEVEL
-- SECURITY, which binds the table OWNER — the role migrations run as.
-- breeze_current_scope() defaults to 'none', under which breeze_has_org_access
-- and breeze_has_partner_access are both false. Without the elevation the
-- backfill below is a silent 0-row no-op on any connection that does not bypass
-- RLS (the RAISE WARNING prints a truthful-looking `0`), and the coherence
-- trigger cannot see PARTNER-WIDE definitions at all — there is no partner-wide
-- SELECT branch on custom_field_definitions yet (#4944) — so it would reject
-- every legitimate partner-wide value. CI's superuser and hosted prod's
-- BYPASSRLS-carrying `doadmin` both mask this; a self-hosted migration role
-- without BYPASSRLS does not. set_config(..., true) is transaction-local, and
-- autoMigrate's per-file client.begin is that transaction.
--
-- NEVER as a function ATTRIBUTE. `SET "breeze.scope" = 'system'` on the function
-- header is superuser-only for a custom (dotted) GUC, so prod's non-superuser
-- migration role 42501s at CREATE FUNCTION time and the deploy crash-loops (the
-- v0.97.0 EU incident). Both `Check Migrations (non-superuser)` and
-- src/db/migrationGucAttributes.test.ts guard it. The sanctioned form is in-body
-- save/elevate/restore with a SINGLE return path — reference implementation
-- breeze_revalidate_config_policy_feature_references
-- (2026-07-27-a-feature-policy-reference-ownership.sql). `SECURITY DEFINER` and
-- `SET search_path` are kept: search_path is a BUILT-IN GUC, so its attribute
-- form is available to any role.
SELECT set_config('breeze.scope', 'system', true);

-- Blindness probe. Prints what the backfill below is actually able to see
-- BEFORE it reports its counts, so a "copied 0 values" line can be trusted. A
-- devices_with_values of 0 on a region known to have custom fields configured,
-- or an effective_scope that is not 'system', means the elevation did not take
-- and every count below is worthless. (W02's lesson: the detection READ is the
-- dangerous half, not just the write.)
DO $$
DECLARE eff text; total_devices bigint; with_values bigint; total_defs bigint;
BEGIN
  SELECT public.breeze_current_scope() INTO eff;
  SELECT count(*), count(*) FILTER (
           WHERE custom_fields IS NOT NULL AND custom_fields <> '{}'::jsonb)
    INTO total_devices, with_values
    FROM public.devices;
  SELECT count(*) INTO total_defs FROM public.custom_field_definitions;
  RAISE WARNING 'device_custom_field_values probe: effective_scope=%, devices=%, devices_with_values=%, definitions=%',
    eff, total_devices, with_values, total_defs;
  IF eff <> 'system' THEN
    RAISE EXCEPTION 'device_custom_field_values backfill is RLS-blind (effective scope %); refusing to report counts', eff
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- The table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_custom_field_values (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid NOT NULL,
  org_id        uuid NOT NULL,
  definition_id uuid NOT NULL
                REFERENCES custom_field_definitions (id) ON DELETE CASCADE,
  -- DENORMALIZED DELIBERATELY, and the coherence trigger below is what keeps it
  -- honest. services/tenantExport.ts readOrgRows is a bare column projection
  -- with NO joins, so a definition_id-only row exports as an opaque uuid the
  -- data subject cannot read — and a partner-wide definition has org_id NULL,
  -- so it is not in their export at all. The spec's suggested `specific` export
  -- policy cannot fix that: `specific` assigns a DECISION to a column that
  -- already exists, it cannot add one. It also lets the projection trigger
  -- rebuild the jsonb without joining custom_field_definitions on every write,
  -- and gives custom.<key> filters a B-tree they can actually use.
  field_key     varchar(100) NOT NULL,
  value_text    text,
  value_number  double precision,
  value_bool    boolean,
  value_date    date,
  -- 'manual' | 'api' | 'script' | 'import' | 'backfill'
  source        varchar(32) NOT NULL DEFAULT 'manual',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- At most one typed column. ALL-NULL is LEGAL and is how an explicitly
  -- cleared value is stored — customFieldValueSchema has always accepted
  -- z.null(), and a cleared value must stay distinguishable from an absent one.
  CONSTRAINT device_custom_field_values_one_value_chk CHECK (
    (value_text IS NOT NULL)::int + (value_number IS NOT NULL)::int
  + (value_bool IS NOT NULL)::int + (value_date IS NOT NULL)::int <= 1
  )
);

-- ON UPDATE CASCADE + DEFERRABLE INITIALLY DEFERRED, copying
-- device_mtls_certificates / device_external_links. Both halves are load-bearing:
-- moveOrg.ts flips the DEVICE row first and re-stamps child org_ids afterwards,
-- so an IMMEDIATE check fails at step one; and
-- orgLifecycleFoundations.integration.test.ts ("merge contract") fails ANY
-- composite FK referencing an org_id column that is not deferrable, because the
-- org merge runs SET CONSTRAINTS ALL DEFERRED and moves parent and child in
-- separate statements. INITIALLY DEFERRED (not merely DEFERRABLE) additionally
-- lets the move path re-home a value onto the TARGET org before the device row
-- itself has moved — see breeze_rehome_device_custom_field_values below.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_custom_field_values_device_org_fk'
  ) THEN
    ALTER TABLE device_custom_field_values
      ADD CONSTRAINT device_custom_field_values_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES devices (id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS device_custom_field_values_device_def_uq
  ON device_custom_field_values (device_id, definition_id);
-- The index custom.<key> filters have never had.
CREATE INDEX IF NOT EXISTS device_custom_field_values_org_key_text_idx
  ON device_custom_field_values (org_id, field_key, value_text);
CREATE INDEX IF NOT EXISTS device_custom_field_values_definition_idx
  ON device_custom_field_values (definition_id);
CREATE INDEX IF NOT EXISTS device_custom_field_values_device_idx
  ON device_custom_field_values (device_id);

ALTER TABLE device_custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_custom_field_values FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON device_custom_field_values;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_custom_field_values;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_custom_field_values;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_custom_field_values;
CREATE POLICY breeze_org_isolation_select ON device_custom_field_values FOR SELECT
  USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON device_custom_field_values FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON device_custom_field_values FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON device_custom_field_values FOR DELETE
  USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON device_custom_field_values TO breeze_app;

-- ---------------------------------------------------------------------------
-- Coherence: definition_id (and the denormalized field_key) must belong to this
-- row's org.
--
-- The definition is DUAL-AXIS, so there is no single-FK way to say this. Left
-- purely app-layer, a partner-wide `udf7` belonging to partner B could be
-- attached to a device in partner A's org and the direct-org_id RLS policy
-- would not notice.
--
-- ORDERING (same as W03's): this is a BEFORE ROW trigger, and ExecInsert runs BR
-- triggers AHEAD of both ExecWithCheckOptions and ExecConstraints, so a
-- coherence violation surfaces as P0001 even under a tenant context. A forged
-- cross-tenant org_id still surfaces as 42501 from RLS. Both are asserted
-- separately in deviceCustomFieldValues.integration.test.ts.
--
-- THE MERGE FENCE IS NOT OPTIONAL. An org merge repoints devices.org_id EARLY
-- (the registry walk is parents-first) and breeze_cascade_device_org_id's
-- generic loop restamps this table's org_id in the same statement — while the
-- value's definition is still owned by the LOSER org, because
-- custom_field_definitions' own executor runs LATER in the walk. Without the
-- fence every merge of two orgs that both hold custom-field values aborts with
-- P0001. The fence is narrow: the definition's owning org must be actively
-- `status='merging'` AND under the SAME partner as the row's new org (an org
-- merge is same-partner by construction — orgMerge.ts validates it and
-- re-validates in-transaction), so it can never widen into cross-partner
-- leakage. Convergence is guaranteed within the same transaction: the
-- definitions executor either re-homes the value onto the survivor's
-- identically-keyed definition or repoints the loser's definition to the
-- survivor. Pinned by the org-merge test in the suite above.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_device_custom_field_value_coherent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  def_org uuid;
  def_partner uuid;
  def_key varchar(100);
  row_partner uuid;
  merging_ok boolean := false;
BEGIN
  -- Elevate for the cross-axis definition read below; restored before the
  -- single, end-of-body RETURN so 'system' cannot leak into the rest of the
  -- caller's transaction. RAISE paths restore via (sub)transaction rollback.
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT f.org_id, f.partner_id, f.field_key
    INTO def_org, def_partner, def_key
    FROM public.custom_field_definitions f
   WHERE f.id = NEW.definition_id;

  IF def_key IS NULL THEN
    RAISE EXCEPTION 'custom field definition % does not exist', NEW.definition_id
      USING ERRCODE = 'P0001',
            CONSTRAINT = 'device_custom_field_values_coherent';
  END IF;

  IF NEW.field_key <> def_key THEN
    RAISE EXCEPTION 'field_key "%" disagrees with its definition ("%")', NEW.field_key, def_key
      USING ERRCODE = 'P0001',
            CONSTRAINT = 'device_custom_field_values_coherent';
  END IF;

  SELECT o.partner_id INTO row_partner
    FROM public.organizations o WHERE o.id = NEW.org_id;

  IF def_org IS NOT NULL THEN
    IF def_org <> NEW.org_id THEN
      -- Merge fence — see the header block above.
      SELECT EXISTS (
        SELECT 1 FROM public.organizations lo
         WHERE lo.id = def_org
           AND lo.status::text = 'merging'
           AND row_partner IS NOT NULL
           AND lo.partner_id = row_partner
      ) INTO merging_ok;
      IF NOT merging_ok THEN
        RAISE EXCEPTION 'custom field definition % belongs to a different organization', NEW.definition_id
          USING ERRCODE = 'P0001',
                CONSTRAINT = 'device_custom_field_values_coherent';
      END IF;
    END IF;
  ELSE
    IF row_partner IS NULL OR def_partner IS NULL OR row_partner <> def_partner THEN
      RAISE EXCEPTION 'custom field definition % belongs to a different partner', NEW.definition_id
        USING ERRCODE = 'P0001',
              CONSTRAINT = 'device_custom_field_values_coherent';
    END IF;
  END IF;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS device_custom_field_values_coherent ON device_custom_field_values;
CREATE TRIGGER device_custom_field_values_coherent
  BEFORE INSERT OR UPDATE ON device_custom_field_values
  FOR EACH ROW EXECUTE FUNCTION public.breeze_device_custom_field_value_coherent();

-- ---------------------------------------------------------------------------
-- Projection: rebuild devices.custom_fields for touched devices.
--
-- Statement-level with transition tables, matching the partner-export triggers'
-- own shape. The UPDATE on devices is what fires
-- breeze_partner_export_z_custom_values_update (whose comparison predicate is
-- `old.custom_fields IS DISTINCT FROM new.custom_fields`), so the export stamp
-- and the per-org advisory lock behave exactly as they did when the jsonb was
-- written directly.
--
-- WHICH KEYS ARE PRESERVED, AND WHY THE RULE IS THE KEY PATTERN AND NOT
-- "has no visible definition". A key that does not match the enforced
-- ^[a-z][a-z0-9_]*$ pattern (routes/customFields.ts) CANNOT be represented in
-- this table: the FK needs a definition_id and no definition can ever be created
-- for it, not even by the backfill. Such keys — camelCase values written before
-- the pattern was enforced — are preserved, or the first write to any other
-- field on that device would silently delete them.
--
-- Every OTHER key is projected from the table alone. Phrasing the rule as "has
-- no visible definition" instead would defeat defect 4: deleting a definition
-- cascades its values away, and the now-definition-less key would be reclassified
-- as unmanaged and STRANDED in the jsonb forever, which is exactly the bug this
-- wave exists to close. After the backfill every pattern-matching stored key has
-- a definition and a row (JSON nulls included, as all-NULL rows), and every write
-- path rejects a key with no visible definition, so nothing else can reach the
-- jsonb behind this table's back.
--
-- The `IS DISTINCT FROM` guard on the UPDATE is not cosmetic: it is what makes a
-- no-op write take no per-org export lock and emit no WAL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_device_custom_field_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  device_ids uuid[];
BEGIN
  -- Same reasoning as the coherence trigger: this reads custom_field_definitions
  -- across the org/partner axis to decide which stored keys are "unmanaged", and
  -- an org-scoped context cannot see partner-wide rows (#4944).
  PERFORM set_config('breeze.scope', 'system', true);

  IF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT device_id) INTO device_ids FROM old_rows;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT device_id) INTO device_ids FROM new_rows;
  ELSE
    SELECT array_agg(DISTINCT id) INTO device_ids
      FROM (SELECT device_id AS id FROM old_rows
            UNION
            SELECT device_id FROM new_rows) u;
  END IF;

  IF COALESCE(array_length(device_ids, 1), 0) > 0 THEN
    UPDATE public.devices d
       SET custom_fields = projected.obj, updated_at = now()
      FROM (
        SELECT d2.id AS device_id,
               COALESCE(unmanaged.obj, '{}'::jsonb) || COALESCE(managed.obj, '{}'::jsonb) AS obj
          FROM public.devices d2
          LEFT JOIN LATERAL (
            SELECT jsonb_object_agg(e.k, e.v) AS obj
              FROM jsonb_each(COALESCE(d2.custom_fields, '{}'::jsonb)) e(k, v)
             WHERE e.k !~ '^[a-z][a-z0-9_]*$'
          ) unmanaged ON true
          LEFT JOIN LATERAL (
            SELECT jsonb_object_agg(
                     v.field_key,
                     COALESCE(to_jsonb(v.value_text), to_jsonb(v.value_number),
                              to_jsonb(v.value_bool), to_jsonb(v.value_date::text),
                              'null'::jsonb)
                   ) AS obj
              FROM public.device_custom_field_values v
             WHERE v.device_id = d2.id
          ) managed ON true
         WHERE d2.id = ANY(device_ids)
      ) projected
     WHERE d.id = projected.device_id
       AND d.custom_fields IS DISTINCT FROM projected.obj;
  END IF;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS device_custom_field_values_project_ins ON device_custom_field_values;
DROP TRIGGER IF EXISTS device_custom_field_values_project_upd ON device_custom_field_values;
DROP TRIGGER IF EXISTS device_custom_field_values_project_del ON device_custom_field_values;
CREATE TRIGGER device_custom_field_values_project_ins
  AFTER INSERT ON device_custom_field_values
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.breeze_device_custom_field_project();
CREATE TRIGGER device_custom_field_values_project_upd
  AFTER UPDATE ON device_custom_field_values
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.breeze_device_custom_field_project();
CREATE TRIGGER device_custom_field_values_project_del
  AFTER DELETE ON device_custom_field_values
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT
  EXECUTE FUNCTION public.breeze_device_custom_field_project();

-- ---------------------------------------------------------------------------
-- Cross-org device move: re-home values onto the target org's definitions.
--
-- WHY THIS EXISTS AT ALL. A device moving between two orgs of one MSP carries
-- its values, but an ORG-OWNED definition does not move with it. The moment
-- moveOrg flips devices.org_id, breeze_cascade_device_org_id's generic loop
-- restamps this table's org_id — and the coherence trigger then correctly
-- refuses, because the value still names the SOURCE org's definition. Without
-- this helper, W05 would make every cross-org move of a device carrying
-- org-owned custom-field values fail with a raw P0001.
--
-- The disposition (plan W05 Task 3 Step 4, option (a), recommended and approved
-- there): re-point each value onto the TARGET org's identically-keyed VISIBLE
-- definition; drop values that have no counterpart, reporting the count so the
-- move audit can carry it. Values under PARTNER-WIDE definitions need no action
-- when the move stays inside one partner — the definition remains visible, and
-- the generic loop's org_id restamp is all they need. A cross-PARTNER move
-- (system scope only) loses partner-wide visibility too, and this helper drops
-- those values for the same reason and by the same rule.
--
-- WHY ONE STATEMENT SETS BOTH definition_id AND org_id. Setting definition_id
-- alone would name a target-org definition while org_id still says source, which
-- the coherence trigger refuses. The composite FK is INITIALLY DEFERRED, so
-- pointing at the target org before the device row moves is checked at COMMIT.
--
-- WHY IT TAKES THE EXPORT LOCKS FIRST. The re-home and the drop both fire the
-- projection trigger, whose UPDATE on devices fires
-- breeze_partner_export_devices_update, which requests that device's org export
-- lock. Those locks must be acquired in ascending UUID order for the whole
-- transaction, and breeze_cascade_device_org_id later requests BOTH orgs. Taking
-- the source alone first would abort the move whenever the target's uuid sorts
-- lower — a coin-flip per move. Pre-acquiring the pair through the same helper
-- (which sorts them itself) makes every later request a held-lock no-op. This is
-- exactly what breeze_cascade_device_org_id does and for exactly the same
-- reason.
--
-- WHY IT IS A DB FUNCTION AND NOT INLINE SQL IN moveOrg.ts. It has to read
-- custom_field_definitions across the org/partner axis, which an org-scoped
-- request context cannot do (#4944), and it has to hold the lock-order knowledge
-- next to the trigger it protects.
--
-- (The org MERGE path deliberately does NOT call this: there the loser's
-- definitions travel to the survivor wholesale, so dropping anything would be
-- data loss. The coherence trigger's merge fence covers that path instead.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.breeze_rehome_device_custom_field_values(
  p_device_id uuid,
  p_target_org_id uuid
)
RETURNS TABLE (rehomed int, dropped int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  source_org_id uuid;
  target_partner_id uuid;
  n_rehomed int := 0;
  n_dropped int := 0;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  SELECT d.org_id INTO source_org_id FROM public.devices d WHERE d.id = p_device_id;
  SELECT o.partner_id INTO target_partner_id
    FROM public.organizations o WHERE o.id = p_target_org_id;

  IF source_org_id IS NULL OR target_partner_id IS NULL OR source_org_id = p_target_org_id THEN
    PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
    rehomed := 0;
    dropped := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  PERFORM public.breeze_partner_export_lock_orgs_exclusive(
    ARRAY[source_org_id, p_target_org_id]
  );

  -- 1. Re-point onto the target org's identically-keyed VISIBLE definition.
  --    W03 guarantees at most one such definition per key per org, so the
  --    lateral is single-valued and (device_id, definition_id) cannot collide:
  --    the device could not already hold a value under a definition its SOURCE
  --    org could not see.
  WITH candidate AS (
    SELECT v.id AS value_id, tgt.id AS target_definition_id
      FROM public.device_custom_field_values v
      JOIN public.custom_field_definitions cur ON cur.id = v.definition_id
      CROSS JOIN LATERAL (
        SELECT f.id
          FROM public.custom_field_definitions f
         WHERE f.field_key = v.field_key
           AND (f.org_id = p_target_org_id
                OR (f.org_id IS NULL AND f.partner_id = target_partner_id))
         LIMIT 1
      ) tgt
     WHERE v.device_id = p_device_id
       AND tgt.id <> v.definition_id
  ), moved AS (
    UPDATE public.device_custom_field_values v
       SET definition_id = candidate.target_definition_id,
           org_id = p_target_org_id,
           updated_at = now()
      FROM candidate
     WHERE v.id = candidate.value_id
    RETURNING 1
  )
  SELECT count(*)::int INTO n_rehomed FROM moved;

  -- 2. Drop anything the target org cannot see. Reported, never silent.
  WITH gone AS (
    DELETE FROM public.device_custom_field_values v
     WHERE v.device_id = p_device_id
       AND NOT EXISTS (
         SELECT 1 FROM public.custom_field_definitions f
          WHERE f.id = v.definition_id
            AND (f.org_id = p_target_org_id
                 OR (f.org_id IS NULL AND f.partner_id = target_partner_id)))
    RETURNING 1
  )
  SELECT count(*)::int INTO n_dropped FROM gone;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  rehomed := n_rehomed;
  dropped := n_dropped;
  RETURN NEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION public.breeze_rehome_device_custom_field_values(uuid, uuid) TO breeze_app;

-- ---------------------------------------------------------------------------
-- Backfill.
--
-- Order inside this file matters: the backfill must run AFTER the projection
-- trigger exists (its INSERT fires the trigger, which recomputes the SAME object
-- it just read, so the devices UPDATE is a guarded no-op) and it must live in
-- THIS file rather than a follow-up one — between two files the projection
-- trigger would rebuild every device's jsonb from an empty table and erase the
-- data.
-- ---------------------------------------------------------------------------

-- 1. Mint an org-owned text definition for every stored key that has no visible
--    definition and CAN be created (the enforced ^[a-z][a-z0-9_]*$ pattern).
--    Not doing this would strand those values: the FK needs a definition_id. A
--    camelCase key cannot be minted (the pattern is enforced on every create
--    path) and is instead PRESERVED by the projection trigger's unmanaged
--    branch — counted below so it is on the record either way.
DO $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  WITH stored AS (
    SELECT DISTINCT d.org_id, o.partner_id, e.k AS field_key
      FROM public.devices d
      JOIN public.organizations o ON o.id = d.org_id
      CROSS JOIN LATERAL jsonb_each(COALESCE(d.custom_fields, '{}'::jsonb)) e(k, v)
     WHERE d.custom_fields IS NOT NULL AND d.custom_fields <> '{}'::jsonb
  ), minted AS (
    INSERT INTO public.custom_field_definitions (org_id, name, field_key, type)
    SELECT s.org_id, s.field_key, s.field_key, 'text'
      FROM stored s
     WHERE s.field_key ~ '^[a-z][a-z0-9_]*$'
       AND NOT EXISTS (
         SELECT 1 FROM public.custom_field_definitions f
          WHERE f.field_key = s.field_key
            AND (f.org_id = s.org_id
                 OR (f.org_id IS NULL AND f.partner_id = s.partner_id)))
    RETURNING 1
  )
  SELECT count(*) INTO n FROM minted;
  RAISE WARNING 'device_custom_field_values backfill: minted % definition(s) for previously undefined keys', n;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT count(*) INTO n FROM (
    SELECT DISTINCT d.id, e.k
      FROM public.devices d
      CROSS JOIN LATERAL jsonb_each(COALESCE(d.custom_fields, '{}'::jsonb)) e(k, v)
     WHERE e.k !~ '^[a-z][a-z0-9_]*$') x;
  RAISE WARNING 'device_custom_field_values backfill: % stored key(s) do not match the enforced key pattern and stay in the jsonb projection only', n;
END $$;

-- 2. Copy every stored value in. `type` decides which typed column it lands in;
--    a value that does not parse for its declared type falls back to value_text
--    rather than being dropped — this is a data MOVE, not a validation gate, and
--    validation now happens on the write paths (W04). The CASE ladder is
--    deliberately verbose rather than clever: every branch says which column a
--    value lands in and what happens when it does not parse. A silently dropped
--    value here is unrecoverable.
--
--    W03 is what makes the definitions join SINGLE-VALUED. With cross-axis
--    shadowing forbidden, `f.field_key = e.k AND (org OR partner-wide)` matches
--    at most one definition; without it the insert would violate
--    device_custom_field_values_device_def_uq, or worse pick arbitrarily.
DO $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO public.device_custom_field_values
    (device_id, org_id, definition_id, field_key,
     value_text, value_number, value_bool, value_date, source)
  SELECT d.id, d.org_id, f.id, f.field_key,
         CASE
           WHEN f.type = 'number' AND (e.v #>> '{}') ~ '^-?\d+(\.\d+)?$' THEN NULL
           WHEN f.type = 'boolean' AND lower(e.v #>> '{}') IN ('true', 'false') THEN NULL
           WHEN f.type = 'date' AND (e.v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}' THEN NULL
           ELSE e.v #>> '{}'
         END,
         CASE WHEN f.type = 'number' AND (e.v #>> '{}') ~ '^-?\d+(\.\d+)?$'
              THEN (e.v #>> '{}')::double precision ELSE NULL END,
         CASE WHEN f.type = 'boolean' AND lower(e.v #>> '{}') IN ('true', 'false')
              THEN (lower(e.v #>> '{}'))::boolean ELSE NULL END,
         CASE WHEN f.type = 'date' AND (e.v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}'
              THEN left(e.v #>> '{}', 10)::date ELSE NULL END,
         'backfill'
    FROM public.devices d
    JOIN public.organizations o ON o.id = d.org_id
    CROSS JOIN LATERAL jsonb_each(COALESCE(d.custom_fields, '{}'::jsonb)) e(k, v)
    JOIN public.custom_field_definitions f
      ON f.field_key = e.k
     AND (f.org_id = d.org_id OR (f.org_id IS NULL AND f.partner_id = o.partner_id))
  -- JSON nulls are copied too, as all-NULL rows. `{"asset_tag": null}` is an
  -- EXPLICITLY CLEARED value, which is exactly what an all-NULL row means here
  -- (customFieldValueSchema has always accepted z.null()). Skipping them would
  -- leave the key with no row, and the projection — which now rebuilds every
  -- pattern-matching key from this table alone — would drop it from the jsonb
  -- entirely, turning "cleared" into "never set" on the first write to any other
  -- field on that device.
  ON CONFLICT (device_id, definition_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'device_custom_field_values backfill: copied % value(s) out of devices.custom_fields', n;
END $$;
