-- Durable automation resource ownership bindings (S0 Track A, Task 2).
-- Sequenced after the already-shipped 2026-09-24-b migration set.
--
-- Every row copies the standalone automation's dual owner axes and records the
-- resource ownership observed when the reference was admitted. Legacy action
-- JSON is reconciled in bounded 500-automation batches: owned references become
-- active; missing, malformed, deleted, or foreign references are retained as
-- quarantined evidence with a stable metadata-free reason. Reconciliation never
-- creates automation_runs or any downstream execution row.
--
-- Tenancy: dual-axis (org_id XOR partner_id), ENABLE + FORCE RLS, with a single
-- system-or-org-or-partner policy covering all DML. The constraint trigger makes
-- binding/parent owner drift unrepresentable and rejects expected resource axes
-- outside the parent tenant. Runtime resolution remains the authority that loads
-- the referenced row and compares its current owner immediately before use.
--
-- Idempotent: guarded enum/table/constraints, replaceable functions/triggers,
-- IF NOT EXISTS indexes, replaceable policy, and ON CONFLICT backfill inserts.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'automation_resource_kind') THEN
    CREATE TYPE automation_resource_kind AS ENUM ('script', 'software_catalog', 'notification_channel');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'automation_resource_binding_state') THEN
    CREATE TYPE automation_resource_binding_state AS ENUM ('active', 'quarantined');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS automation_resource_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL,
  org_id uuid,
  partner_id uuid,
  resource_kind automation_resource_kind NOT NULL,
  resource_id text NOT NULL,
  expected_resource_org_id uuid,
  expected_resource_partner_id uuid,
  expected_resource_is_system boolean NOT NULL DEFAULT false,
  state automation_resource_binding_state NOT NULL DEFAULT 'active',
  reason varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_resource_bindings_automation_id_fkey'
      AND conrelid = 'automation_resource_bindings'::regclass
  ) THEN
    ALTER TABLE automation_resource_bindings
      ADD CONSTRAINT automation_resource_bindings_automation_id_fkey
      FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_resource_bindings_org_id_fkey'
      AND conrelid = 'automation_resource_bindings'::regclass
  ) THEN
    ALTER TABLE automation_resource_bindings
      ADD CONSTRAINT automation_resource_bindings_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES organizations(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_resource_bindings_partner_id_fkey'
      AND conrelid = 'automation_resource_bindings'::regclass
  ) THEN
    ALTER TABLE automation_resource_bindings
      ADD CONSTRAINT automation_resource_bindings_partner_id_fkey
      FOREIGN KEY (partner_id) REFERENCES partners(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_resource_bindings_expected_org_id_fkey'
      AND conrelid = 'automation_resource_bindings'::regclass
  ) THEN
    ALTER TABLE automation_resource_bindings
      ADD CONSTRAINT automation_resource_bindings_expected_org_id_fkey
      FOREIGN KEY (expected_resource_org_id) REFERENCES organizations(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_resource_bindings_expected_partner_id_fkey'
      AND conrelid = 'automation_resource_bindings'::regclass
  ) THEN
    ALTER TABLE automation_resource_bindings
      ADD CONSTRAINT automation_resource_bindings_expected_partner_id_fkey
      FOREIGN KEY (expected_resource_partner_id) REFERENCES partners(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_resource_bindings_one_owner_chk'
      AND conrelid = 'automation_resource_bindings'::regclass
  ) THEN
    ALTER TABLE automation_resource_bindings
      ADD CONSTRAINT automation_resource_bindings_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'automation_resource_bindings_expected_owner_chk'
      AND conrelid = 'automation_resource_bindings'::regclass
  ) THEN
    ALTER TABLE automation_resource_bindings
      ADD CONSTRAINT automation_resource_bindings_expected_owner_chk
      CHECK (
        (expected_resource_is_system = true
          AND expected_resource_org_id IS NULL
          AND expected_resource_partner_id IS NULL)
        OR
        (expected_resource_is_system = false
          AND (expected_resource_org_id IS NOT NULL OR expected_resource_partner_id IS NOT NULL))
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS automation_resource_bindings_automation_idx
  ON automation_resource_bindings(automation_id);
CREATE INDEX IF NOT EXISTS automation_resource_bindings_org_idx
  ON automation_resource_bindings(org_id);
CREATE INDEX IF NOT EXISTS automation_resource_bindings_partner_idx
  ON automation_resource_bindings(partner_id);
CREATE INDEX IF NOT EXISTS automation_resource_bindings_state_idx
  ON automation_resource_bindings(state);
CREATE UNIQUE INDEX IF NOT EXISTS automation_resource_bindings_identity_uniq
  ON automation_resource_bindings(automation_id, resource_kind, resource_id);

CREATE OR REPLACE FUNCTION public.automation_resource_binding_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_org_id uuid;
  parent_partner_id uuid;
  organization_partner_id uuid;
BEGIN
  SELECT a.org_id, a.partner_id
  INTO parent_org_id, parent_partner_id
  FROM public.automations AS a
  WHERE a.id = NEW.automation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'insert or update on table "automation_resource_bindings" violates foreign key constraint "automation_resource_bindings_automation_id_fkey"'
      USING ERRCODE = '23503',
            CONSTRAINT = 'automation_resource_bindings_automation_id_fkey';
  END IF;

  IF NEW.org_id IS DISTINCT FROM parent_org_id
     OR NEW.partner_id IS DISTINCT FROM parent_partner_id THEN
    RAISE EXCEPTION 'automation binding owner differs from parent automation owner'
      USING ERRCODE = '23514',
            CONSTRAINT = 'automation_resource_bindings_parent_owner_chk';
  END IF;

  IF NEW.expected_resource_is_system THEN
    RETURN NEW;
  END IF;

  IF NEW.org_id IS NOT NULL THEN
    SELECT o.partner_id INTO organization_partner_id
    FROM public.organizations AS o
    WHERE o.id = NEW.org_id;

    IF (NEW.expected_resource_org_id IS NOT NULL
          AND NEW.expected_resource_org_id IS DISTINCT FROM NEW.org_id)
       OR (NEW.expected_resource_partner_id IS NOT NULL
          AND NEW.expected_resource_partner_id IS DISTINCT FROM organization_partner_id) THEN
      RAISE EXCEPTION 'automation binding expected resource owner is outside the parent tenant'
        USING ERRCODE = '23514',
              CONSTRAINT = 'automation_resource_bindings_expected_tenant_chk';
    END IF;
  ELSE
    IF NEW.expected_resource_org_id IS NOT NULL
       OR NEW.expected_resource_partner_id IS DISTINCT FROM NEW.partner_id THEN
      RAISE EXCEPTION 'automation binding expected resource owner is outside the parent tenant'
        USING ERRCODE = '23514',
              CONSTRAINT = 'automation_resource_bindings_expected_tenant_chk';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS automation_resource_bindings_owner_guard_trg
  ON automation_resource_bindings;
CREATE CONSTRAINT TRIGGER automation_resource_bindings_owner_guard_trg
AFTER INSERT OR UPDATE OF
  automation_id,
  org_id,
  partner_id,
  expected_resource_org_id,
  expected_resource_partner_id,
  expected_resource_is_system
ON automation_resource_bindings
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION public.automation_resource_binding_owner_guard();

-- The child-side trigger protects binding writes. This reverse guard prevents
-- an owner-axis UPDATE on the parent from invalidating already-persisted rows.
CREATE OR REPLACE FUNCTION automation_owner_binding_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.partner_id IS DISTINCT FROM OLD.partner_id)
     AND EXISTS (
       SELECT 1
       FROM automation_resource_bindings b
       WHERE b.automation_id = NEW.id
         AND (b.org_id IS DISTINCT FROM NEW.org_id OR b.partner_id IS DISTINCT FROM NEW.partner_id)
     ) THEN
    RAISE EXCEPTION 'automation binding owner differs from parent automation owner'
      USING ERRCODE = '23514',
            CONSTRAINT = 'automation_resource_bindings_parent_owner_chk';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS automations_binding_owner_guard_trg ON automations;
CREATE CONSTRAINT TRIGGER automations_binding_owner_guard_trg
AFTER UPDATE OF org_id, partner_id ON automations
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION automation_owner_binding_guard();

ALTER TABLE automation_resource_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_resource_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS automation_resource_bindings_isolation
  ON automation_resource_bindings;
CREATE POLICY automation_resource_bindings_isolation
ON automation_resource_bindings
USING (
  public.breeze_current_scope() = 'system'
  OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
  OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
)
WITH CHECK (
  public.breeze_current_scope() = 'system'
  OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
  OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON automation_resource_bindings TO breeze_app;

-- Bounded and idempotent reconciliation of legacy JSON references.
DO $$
DECLARE
  batch_rows integer;
  inserted_rows integer;
  active_rows integer := 0;
  quarantined_rows integer := 0;
  last_automation_id uuid := '00000000-0000-0000-0000-000000000000';
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS automation_binding_backfill_batch (
    id uuid PRIMARY KEY
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS automation_binding_backfill_refs (
    automation_id uuid NOT NULL,
    org_id uuid,
    partner_id uuid,
    owner_partner_id uuid NOT NULL,
    resource_kind automation_resource_kind NOT NULL,
    resource_id text NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS automation_binding_backfill_resolved (
    automation_id uuid NOT NULL,
    org_id uuid,
    partner_id uuid,
    resource_kind automation_resource_kind NOT NULL,
    resource_id text NOT NULL,
    expected_org_id uuid,
    expected_partner_id uuid,
    expected_is_system boolean NOT NULL,
    is_valid boolean NOT NULL
  ) ON COMMIT DROP;

  LOOP
    TRUNCATE automation_binding_backfill_batch;
    TRUNCATE automation_binding_backfill_refs;
    TRUNCATE automation_binding_backfill_resolved;

    INSERT INTO automation_binding_backfill_batch (id)
    SELECT a.id
    FROM automations a
    WHERE a.id > last_automation_id
    ORDER BY a.id
    LIMIT 500;
    GET DIAGNOSTICS batch_rows = ROW_COUNT;
    EXIT WHEN batch_rows = 0;

    SELECT id INTO last_automation_id
    FROM automation_binding_backfill_batch
    ORDER BY id DESC
    LIMIT 1;

    INSERT INTO automation_binding_backfill_refs (
      automation_id, org_id, partner_id, owner_partner_id, resource_kind, resource_id
    )
    SELECT DISTINCT
      a.id,
      a.org_id,
      a.partner_id,
      COALESCE(a.partner_id, o.partner_id),
      refs.resource_kind,
      refs.resource_id
    FROM automation_binding_backfill_batch batch
    JOIN automations a ON a.id = batch.id
    LEFT JOIN organizations o ON o.id = a.org_id
    CROSS JOIN LATERAL (
      SELECT 'script'::automation_resource_kind, action ->> 'scriptId'
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.actions) = 'array' THEN a.actions ELSE '[]'::jsonb END
      ) action
      WHERE action ->> 'type' = 'run_script'
      UNION ALL
      SELECT 'software_catalog'::automation_resource_kind, action ->> 'catalogId'
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.actions) = 'array' THEN a.actions ELSE '[]'::jsonb END
      ) action
      WHERE action ->> 'type' = 'deploy_software'
      UNION ALL
      SELECT 'notification_channel'::automation_resource_kind, action ->> 'notificationChannelId'
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.actions) = 'array' THEN a.actions ELSE '[]'::jsonb END
      ) action
      WHERE action ->> 'type' = 'send_notification'
      UNION ALL
      SELECT 'notification_channel'::automation_resource_kind, target #>> '{}'
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(a.notification_targets) = 'array'
            THEN a.notification_targets
          WHEN jsonb_typeof(a.notification_targets -> 'channelIds') = 'array'
            THEN a.notification_targets -> 'channelIds'
          WHEN jsonb_typeof(a.notification_targets -> 'notificationChannelIds') = 'array'
            THEN a.notification_targets -> 'notificationChannelIds'
          ELSE '[]'::jsonb
        END
      ) target
    ) AS refs(resource_kind, resource_id)
    WHERE refs.resource_id IS NOT NULL
      AND refs.resource_id <> '';

    INSERT INTO automation_binding_backfill_resolved (
      automation_id,
      org_id,
      partner_id,
      resource_kind,
      resource_id,
      expected_org_id,
      expected_partner_id,
      expected_is_system,
      is_valid
    )
    SELECT
      r.automation_id,
      r.org_id,
      r.partner_id,
      r.resource_kind,
      r.resource_id,
      CASE
        WHEN validity.is_valid AND r.resource_kind = 'script' THEN s.org_id
        WHEN validity.is_valid AND r.resource_kind = 'software_catalog' THEN sc.org_id
        WHEN validity.is_valid AND r.resource_kind = 'notification_channel' THEN nc.org_id
        ELSE r.org_id
      END,
      CASE
        WHEN validity.is_valid AND r.resource_kind = 'script' THEN s.partner_id
        WHEN validity.is_valid AND r.resource_kind = 'software_catalog' THEN sc.partner_id
        WHEN validity.is_valid AND r.resource_kind = 'notification_channel' THEN nc.partner_id
        ELSE r.owner_partner_id
      END,
      CASE WHEN validity.is_valid AND r.resource_kind = 'script' THEN s.is_system ELSE false END,
      validity.is_valid
    FROM automation_binding_backfill_refs r
    LEFT JOIN scripts s
      ON r.resource_kind = 'script'
     AND s.id = CASE
       WHEN r.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       THEN r.resource_id::uuid ELSE NULL END
    LEFT JOIN software_catalog sc
      ON r.resource_kind = 'software_catalog'
     AND sc.id = CASE
       WHEN r.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       THEN r.resource_id::uuid ELSE NULL END
    LEFT JOIN notification_channels nc
      ON r.resource_kind = 'notification_channel'
     AND nc.id = CASE
       WHEN r.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       THEN r.resource_id::uuid ELSE NULL END
    CROSS JOIN LATERAL (
      SELECT CASE r.resource_kind
        WHEN 'script' THEN
          s.id IS NOT NULL
          AND s.deleted_at IS NULL
          AND (
            s.is_system
            OR (r.org_id IS NULL AND s.org_id IS NULL AND s.partner_id = r.owner_partner_id)
            OR (r.org_id IS NOT NULL AND (
              (s.org_id = r.org_id AND s.partner_id = r.owner_partner_id)
              OR (s.org_id IS NULL AND s.partner_id = r.owner_partner_id)
            ))
          )
        WHEN 'software_catalog' THEN
          sc.id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM software_versions sv
            WHERE sv.catalog_id = sc.id AND sv.is_latest = true
          )
          AND (
            (r.org_id IS NULL AND sc.org_id IS NULL AND sc.partner_id = r.owner_partner_id)
            OR (r.org_id IS NOT NULL AND (
              (sc.org_id = r.org_id AND sc.partner_id IS NULL)
              OR (sc.org_id IS NULL AND sc.partner_id = r.owner_partner_id)
            ))
          )
        WHEN 'notification_channel' THEN
          nc.id IS NOT NULL
          AND (
            (r.org_id IS NULL AND nc.org_id IS NULL AND nc.partner_id = r.owner_partner_id)
            OR (r.org_id IS NOT NULL AND (
              (nc.org_id = r.org_id AND nc.partner_id IS NULL)
              OR (nc.org_id IS NULL AND nc.partner_id = r.owner_partner_id)
            ))
          )
        ELSE false
      END AS is_valid
    ) validity;

    INSERT INTO automation_resource_bindings (
      automation_id,
      org_id,
      partner_id,
      resource_kind,
      resource_id,
      expected_resource_org_id,
      expected_resource_partner_id,
      expected_resource_is_system,
      state,
      reason
    )
    SELECT
      automation_id,
      org_id,
      partner_id,
      resource_kind,
      resource_id,
      expected_org_id,
      expected_partner_id,
      expected_is_system,
      'active',
      NULL
    FROM automation_binding_backfill_resolved
    WHERE is_valid
    ON CONFLICT (automation_id, resource_kind, resource_id) DO NOTHING;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    active_rows := active_rows + inserted_rows;

    INSERT INTO automation_resource_bindings (
      automation_id,
      org_id,
      partner_id,
      resource_kind,
      resource_id,
      expected_resource_org_id,
      expected_resource_partner_id,
      expected_resource_is_system,
      state,
      reason
    )
    SELECT
      automation_id,
      org_id,
      partner_id,
      resource_kind,
      resource_id,
      expected_org_id,
      expected_partner_id,
      expected_is_system,
      'quarantined',
      'unknown_or_unauthorized_reference'
    FROM automation_binding_backfill_resolved
    WHERE NOT is_valid
    ON CONFLICT (automation_id, resource_kind, resource_id) DO NOTHING;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    quarantined_rows := quarantined_rows + inserted_rows;
  END LOOP;

  RAISE WARNING 'automation-resource-bindings: backfilled % active binding(s)', active_rows;
  RAISE WARNING 'automation-resource-bindings: quarantined % binding(s)', quarantined_rows;
END $$;
