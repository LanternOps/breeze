-- AI model registry W02 (#7600, spec §5.2): partner_ai_connections.
--
-- How models are reached: one row per partner-owned connection. It fixes the
-- destination, the funding source (partner_key) and the inference geography.
-- The platform connection is implicit (connection_id NULL on an offering).
--
-- TENANCY: shape 3 (partner axis), exactly like partner_llm_configs. One
-- FOR ALL policy on breeze_has_partner_access(partner_id). There is
-- deliberately NO org-token read path — a connection carries key material
-- metadata (last4, fingerprint, status) that org users never see.
-- Listed in PARTNER_TENANT_TABLES. No org_id, so no org cascade / export entry;
-- cascadeDeletePartner's information_schema partner_id sweep erases it.
--
-- ID-PRESERVING COPY (quorum #13): every partner_llm_configs row is copied
-- with the SAME id and the SAME api_key_encrypted bytes. The column is
-- registered in encryptedColumnRegistry with
-- aadTag 'partner_llm_configs.api_key_encrypted' + aadBinding 'row', so the
-- copied ciphertext decrypts unchanged and a blob pasted into another
-- partner's row does not. The ciphertext never leaves Postgres.
--
-- W02 KEEPS partner_llm_configs AS THE ROUTING SOURCE. This table is kept a
-- projection of it by this copy, by the boot reconcile and by the
-- /ai/provider facade (services/aiModels/legacyReconcile.ts). W08 drops the
-- legacy table and legacy_default_model.
--
-- legacy_default_model is the compat projection of
-- partner_llm_configs.default_model for GET /ai/provider (NULL = "tracks the
-- deployment default"). Nothing routes on it.
--
-- partner_ai_connections_compat_uq is TEMPORARY: it guarantees the
-- /ai/provider compat facade addresses exactly one connection per partner.
-- W04 drops it when the multi-connection UI lands.
--
-- Idempotent: CREATE … IF NOT EXISTS, constraint checks against pg_constraint
-- (the id/partner UNIQUE is an FK target, so it is never dropped and
-- re-added), DROP POLICY IF EXISTS + CREATE, ON CONFLICT (id) DO NOTHING.
-- WRITES ROWS: system scope is elected first inside the DO block (FORCE RLS
-- binds the migration role). No BEGIN/COMMIT — autoMigrate wraps the file.

CREATE TABLE IF NOT EXISTS public.partner_ai_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  inference_geo text,
  provider_config jsonb,
  api_key_encrypted text,
  key_last4 text,
  key_fingerprint text,
  -- No ON DELETE: deleting a catalog entry a connection is pinned to must fail
  -- loud, the same as partner_llm_configs.catalog_entry_id.
  catalog_entry_id uuid REFERENCES public.llm_provider_catalog(id),
  base_url text,
  status text NOT NULL DEFAULT 'active',
  last_error text,
  verified_at timestamptz,
  config_version integer NOT NULL DEFAULT 1,
  connected_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  last_discovered_at timestamptz,
  discovery_error text,
  legacy_default_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_ai_connections_id_partner_uq'
      AND conrelid = 'public.partner_ai_connections'::regclass
  ) THEN
    ALTER TABLE public.partner_ai_connections
      ADD CONSTRAINT partner_ai_connections_id_partner_uq UNIQUE (id, partner_id);
  END IF;
END $$;

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_kind_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_kind_chk
  CHECK (kind IN ('anthropic_byok', 'catalog', 'openai_compatible'));

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_status_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_status_chk
  CHECK (status IN ('active', 'error'));

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_shape_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_shape_chk CHECK (
  -- catalog ⇔ a catalog entry
  (kind = 'catalog') = (catalog_entry_id IS NOT NULL)
  -- openai_compatible ⇔ a base URL (W06); Anthropic-dialect kinds never carry one
  AND (kind = 'openai_compatible') = (base_url IS NOT NULL)
  -- the Anthropic-dialect kinds always carry a key
  AND (kind NOT IN ('anthropic_byok', 'catalog') OR api_key_encrypted IS NOT NULL)
);

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_key_triplet_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_key_triplet_chk
  CHECK (num_nulls(api_key_encrypted, key_last4, key_fingerprint) IN (0, 3));

ALTER TABLE public.partner_ai_connections DROP CONSTRAINT IF EXISTS partner_ai_connections_config_version_chk;
ALTER TABLE public.partner_ai_connections ADD CONSTRAINT partner_ai_connections_config_version_chk
  CHECK (config_version >= 1);

CREATE INDEX IF NOT EXISTS partner_ai_connections_partner_idx
  ON public.partner_ai_connections (partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS partner_ai_connections_compat_uq
  ON public.partner_ai_connections (partner_id)
  WHERE kind IN ('anthropic_byok', 'catalog');

ALTER TABLE public.partner_ai_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_ai_connections FORCE ROW LEVEL SECURITY;

-- No TO clause (see the migration-owner note below): table privileges, not
-- the policy, are what restrict who can reach the table.
DROP POLICY IF EXISTS partner_ai_connections_partner_access ON public.partner_ai_connections;
CREATE POLICY partner_ai_connections_partner_access ON public.partner_ai_connections
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_ai_connections TO breeze_app;

-- LEGACY UPDATE MIRROR. Every UPDATE of a partner_llm_configs row — the
-- /ai/provider facade's writes and the resolver's runtime
-- markPartnerLlmError (status='error', CAS on config_version) — is re-applied
-- to the same-id connection in the same statement, so GET /ai/provider (which
-- reads the registry) never shows a stale status/key/pin. Runs with the
-- writer's RLS (every legacy writer runs in system scope, or as the owning
-- partner, which may update its own connection). INSERT/DELETE are not
-- mirrored here: a delete must re-point assignments first, which only
-- services/aiModels/legacyReconcile.ts can do.
-- W02-ONLY SCAFFOLDING: W03 Task 6B stops all legacy writes and drops this
-- trigger (2026-11-19-100500-drop-partner-llm-configs-mirror-trigger.sql).
CREATE OR REPLACE FUNCTION public.partner_llm_configs_mirror_to_connection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.partner_ai_connections AS c
     SET kind = CASE WHEN NEW.catalog_entry_id IS NULL THEN 'anthropic_byok' ELSE 'catalog' END,
         api_key_encrypted = NEW.api_key_encrypted,
         key_last4 = NEW.key_last4,
         key_fingerprint = NEW.key_fingerprint,
         catalog_entry_id = NEW.catalog_entry_id,
         status = NEW.status,
         last_error = NEW.last_error,
         verified_at = NEW.verified_at,
         config_version = NEW.config_version,
         connected_by = NEW.connected_by,
         legacy_default_model = NEW.default_model,
         updated_at = now()
   WHERE c.id = NEW.id;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS partner_llm_configs_mirror_to_connection ON public.partner_llm_configs;
CREATE TRIGGER partner_llm_configs_mirror_to_connection
  AFTER UPDATE ON public.partner_llm_configs
  FOR EACH ROW EXECUTE FUNCTION public.partner_llm_configs_mirror_to_connection();

-- MIGRATION-OWNER VISIBILITY. partner_llm_configs' only policy is
-- `... FOR ALL TO breeze_app` (2026-09-04). A role-restricted policy does not
-- apply to a NOBYPASSRLS migration owner, so under FORCE RLS the copy below
-- would SELECT zero rows even with breeze.scope = 'system' (measured on PG16
-- in 2026-10-09-000600-rls-scoped-replay-v0110.sql). This system-only policy
-- has no TO clause; it grants breeze_app nothing new (its own policy already
-- has the system branch) and confers no table privileges. Shape mirrors
-- ai_kill_state_system_only.
DROP POLICY IF EXISTS partner_llm_configs_system_only ON public.partner_llm_configs;
CREATE POLICY partner_llm_configs_system_only ON public.partner_llm_configs
  FOR ALL
  USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');

DO $copy$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO public.partner_ai_connections (
    id, partner_id, kind, name,
    api_key_encrypted, key_last4, key_fingerprint,
    catalog_entry_id, status, last_error, verified_at, config_version,
    connected_by, legacy_default_model, created_at, updated_at
  )
  SELECT c.id,
         c.partner_id,
         CASE WHEN c.catalog_entry_id IS NULL THEN 'anthropic_byok' ELSE 'catalog' END,
         COALESCE(e.name, 'Anthropic API key'),
         c.api_key_encrypted, c.key_last4, c.key_fingerprint,
         c.catalog_entry_id, c.status, c.last_error, c.verified_at, c.config_version,
         c.connected_by, c.default_model, c.created_at, c.updated_at
    FROM public.partner_llm_configs AS c
    LEFT JOIN public.llm_provider_catalog AS e ON e.id = c.catalog_entry_id
  ON CONFLICT (id) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'partner_ai_connections: copied % partner_llm_configs row(s) with id-preserving ciphertext', n;
  ELSE
    RAISE NOTICE 'partner_ai_connections: copied % partner_llm_configs row(s) with id-preserving ciphertext', n;
  END IF;
END $copy$;
