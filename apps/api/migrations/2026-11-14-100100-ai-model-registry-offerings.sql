-- AI model registry W02 (#7600, spec §5.3): partner_ai_models — the models a
-- partner can use, each through exactly one connection.
--
-- TENANCY: shape 3 (partner axis). FOR ALL on breeze_has_partner_access, plus
-- ONE separate, additive FOR SELECT policy for org tokens (quorum #12): the
-- chat picker runs under org tokens, which never pass breeze_has_partner_access.
-- The branch reads ENABLED rows of the caller's own partner only, through
-- breeze_current_partner_id() (populated for every scope, including agent
-- tokens — a device can therefore read its partner's enabled offerings: model
-- ids, display names, prices, permission keys; no secrets). It is never
-- appended to the FOR ALL policy: Postgres never consults FOR SELECT policies
-- when computing UPDATE/DELETE targets, so org tokens cannot modify offerings.
-- Listed in PARTNER_TENANT_TABLES.
--
-- PLATFORM IDENTITY IS DERIVED (quorum #2): a platform offering
-- (connection_id NULL) carries ONLY platform_model_id. Wire id, capabilities
-- and price are always read from ai_platform_models, never copied.
-- A catalog offering carries only its logical model_id; endpoint, wire id,
-- price and verification resolve live from the connection's current authorized
-- catalog revision (quorum #7), so it copies no price or capabilities either.
--
-- CROSS-TENANT REFERENCES ARE COMPOSITE FKs (quorum #1):
--   (connection_id, partner_id) -> partner_ai_connections(id, partner_id) CASCADE
--   (refusal_fallback_offering_id, partner_id) -> partner_ai_models(id, partner_id)
-- partner_ai_models_integrity_guard additionally keeps id / partner_id /
-- connection_id immutable (assignment arrays reference offerings without an FK)
-- and requires the refusal fallback to EXIST, fail-closed, on the SAME
-- connection (same destination + funding). Fail-closed matters: a BEFORE
-- trigger can't see a row inserted later in the same multi-row statement,
-- while the (immediate, end-of-statement) FK can.
-- Fallback eligibility (enabled, priced) is checked by the app at write and by
-- the resolver at dispatch (W03).
--
-- Idempotent. Writes no rows (no breeze.scope elevation needed).

CREATE TABLE IF NOT EXISTS public.partner_ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  connection_id uuid,
  platform_model_id uuid REFERENCES public.ai_platform_models(id),
  model_id text,
  source text NOT NULL,
  display_name text,
  capabilities jsonb,
  price_input_cents_per_m numeric(20, 6),
  price_output_cents_per_m numeric(20, 6),
  price_cache_read_cents_per_m numeric(20, 6),
  price_cache_write_cents_per_m numeric(20, 6),
  enabled boolean NOT NULL DEFAULT false,
  default_options jsonb,
  allowed_options jsonb,
  required_permission text,
  refusal_fallback_offering_id uuid,
  lifecycle text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'partner_ai_models_id_partner_uq'
      AND conrelid = 'public.partner_ai_models'::regclass
  ) THEN
    ALTER TABLE public.partner_ai_models
      ADD CONSTRAINT partner_ai_models_id_partner_uq UNIQUE (id, partner_id);
  END IF;
END $$;

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_connection_fk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_connection_fk
  FOREIGN KEY (connection_id, partner_id)
  REFERENCES public.partner_ai_connections (id, partner_id) ON DELETE CASCADE;

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_refusal_fallback_fk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_refusal_fallback_fk
  FOREIGN KEY (refusal_fallback_offering_id, partner_id)
  REFERENCES public.partner_ai_models (id, partner_id);

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_source_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_source_chk
  CHECK (source IN ('platform', 'discovered', 'manual', 'catalog'));

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_lifecycle_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_lifecycle_chk
  CHECK (lifecycle IN ('available', 'missing', 'retired'));

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_platform_shape_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_platform_shape_chk CHECK (
  -- platform offering ⇔ no connection ⇔ source 'platform'
  (source = 'platform') = (connection_id IS NULL)
  -- a platform offering carries nothing but the platform row (quorum #2)
  AND (source <> 'platform' OR (
        platform_model_id IS NOT NULL
        AND model_id IS NULL
        AND capabilities IS NULL
        AND num_nonnulls(price_input_cents_per_m, price_output_cents_per_m,
                         price_cache_read_cents_per_m, price_cache_write_cents_per_m) = 0))
  -- every connection offering names its wire / logical id
  AND (source = 'platform' OR model_id IS NOT NULL)
);

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_catalog_shape_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_catalog_shape_chk CHECK (
  source <> 'catalog' OR (
    platform_model_id IS NULL
    AND capabilities IS NULL
    AND num_nonnulls(price_input_cents_per_m, price_output_cents_per_m,
                     price_cache_read_cents_per_m, price_cache_write_cents_per_m) = 0)
);

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_price_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_price_chk CHECK (
  num_nulls(price_input_cents_per_m, price_output_cents_per_m,
            price_cache_read_cents_per_m, price_cache_write_cents_per_m) IN (0, 4)
  AND COALESCE(price_input_cents_per_m, 0) >= 0
  AND COALESCE(price_output_cents_per_m, 0) >= 0
  AND COALESCE(price_cache_read_cents_per_m, 0) >= 0
  AND COALESCE(price_cache_write_cents_per_m, 0) >= 0
);

ALTER TABLE public.partner_ai_models DROP CONSTRAINT IF EXISTS partner_ai_models_options_shape_chk;
ALTER TABLE public.partner_ai_models ADD CONSTRAINT partner_ai_models_options_shape_chk CHECK (
  (default_options IS NULL OR jsonb_typeof(default_options) = 'object')
  AND (allowed_options IS NULL OR jsonb_typeof(allowed_options) = 'object')
  AND (required_permission IS NULL OR required_permission ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$')
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_ai_models_platform_uq
  ON public.partner_ai_models (partner_id, platform_model_id)
  WHERE connection_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS partner_ai_models_connection_model_uq
  ON public.partner_ai_models (connection_id, model_id)
  WHERE connection_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS partner_ai_models_partner_idx ON public.partner_ai_models (partner_id);
CREATE INDEX IF NOT EXISTS partner_ai_models_platform_model_idx
  ON public.partner_ai_models (platform_model_id) WHERE platform_model_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS partner_ai_models_refusal_fallback_idx
  ON public.partner_ai_models (refusal_fallback_offering_id) WHERE refusal_fallback_offering_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.partner_ai_models_integrity_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fb_connection uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
       OR NEW.connection_id IS DISTINCT FROM OLD.connection_id) THEN
    RAISE EXCEPTION 'partner_ai_models id, partner_id and connection_id are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.refusal_fallback_offering_id IS NOT NULL THEN
    IF NEW.refusal_fallback_offering_id = NEW.id THEN
      RAISE EXCEPTION 'an offering cannot be its own refusal fallback' USING ERRCODE = '23514';
    END IF;
    -- Runs with the writer's RLS: a writer can only name a fallback it can see.
    -- FAIL CLOSED: a fallback that isn't visible yet (another partner's, or a
    -- row later in the same multi-row INSERT) is rejected here.
    SELECT m.connection_id INTO fb_connection
      FROM public.partner_ai_models AS m
     WHERE m.id = NEW.refusal_fallback_offering_id
       AND m.partner_id = NEW.partner_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'refusal fallback % is not an existing offering of this partner', NEW.refusal_fallback_offering_id
        USING ERRCODE = '23503';
    END IF;
    IF fb_connection IS DISTINCT FROM NEW.connection_id THEN
      RAISE EXCEPTION 'a refusal fallback must be on the same connection as its offering'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS partner_ai_models_integrity_guard ON public.partner_ai_models;
CREATE TRIGGER partner_ai_models_integrity_guard
  BEFORE INSERT OR UPDATE OF id, partner_id, connection_id, refusal_fallback_offering_id ON public.partner_ai_models
  FOR EACH ROW EXECUTE FUNCTION public.partner_ai_models_integrity_guard();

ALTER TABLE public.partner_ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_ai_models FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_ai_models_partner_access ON public.partner_ai_models;
CREATE POLICY partner_ai_models_partner_access ON public.partner_ai_models
  FOR ALL
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

DROP POLICY IF EXISTS partner_ai_models_org_read_enabled ON public.partner_ai_models;
CREATE POLICY partner_ai_models_org_read_enabled
  ON public.partner_ai_models
  FOR SELECT
  USING (enabled AND partner_id = public.breeze_current_partner_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_ai_models TO breeze_app;
