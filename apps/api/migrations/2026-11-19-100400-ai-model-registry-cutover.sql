-- AI model registry W03 (#7601, Task 6A): per-partner, durable legacy →
-- registry cutover.
--
-- A partner is projected from legacy config EXACTLY ONCE: its
-- ai_model_registry_partner_cutover row is inserted in the same transaction
-- as W02's reconcile (services/aiModels/registryCutover.ts). Afterwards the
-- registry is the authority (Task 6B) and nothing re-projects the partner.
--
-- ai_model_registry_state is a system singleton: the background sweep's
-- coordinator lease and its monotonic completion stamp. No tenant column.
-- Forced RLS with ONE system-only policy (like manifest_signing_key_delegations):
-- only the system-context sweep ever reads or writes it. Listed in
-- rls-coverage INTENTIONAL_UNSCOPED.
--
-- ai_model_registry_partner_cutover is shape 3 (partner axis): forced RLS,
-- reads on system OR breeze_has_partner_access(partner_id), writes system
-- only (the cutover runs in system context). Listed in PARTNER_TENANT_TABLES.
-- partner_id FK ON DELETE CASCADE, and cascadeDeletePartner's
-- information_schema partner_id sweep also erases it (DELETE granted).
-- Neither table has an org_id: no org cascade / merge / export entry applies.
--
-- Idempotent: CREATE … IF NOT EXISTS, DROP POLICY IF EXISTS + CREATE,
-- ON CONFLICT DO NOTHING. The only row write (the singleton) elects system
-- scope first. No BEGIN/COMMIT — autoMigrate wraps the file.

CREATE TABLE IF NOT EXISTS public.ai_model_registry_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cutover_completed_at timestamptz NULL,
  lease_owner text NULL,
  lease_expires_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_model_registry_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_registry_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_model_registry_state_system_only ON public.ai_model_registry_state;
CREATE POLICY ai_model_registry_state_system_only ON public.ai_model_registry_state
  FOR ALL
  USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');
GRANT SELECT, UPDATE ON public.ai_model_registry_state TO breeze_app;

CREATE TABLE IF NOT EXISTS public.ai_model_registry_partner_cutover (
  partner_id uuid PRIMARY KEY REFERENCES public.partners(id) ON DELETE CASCADE,
  cutover_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_model_registry_partner_cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_model_registry_partner_cutover FORCE ROW LEVEL SECURITY;
-- Reads: system OR the owning partner. Writes (INSERT/UPDATE/DELETE): system
-- only — a partner deleting its own row would make the next request re-project
-- it from legacy config. A FOR ALL policy with a partner USING branch would let
-- exactly that DELETE through (USING governs DELETE row targeting), so the
-- read and write policies are separate. The write policies are
-- `system AND breeze_has_partner_access(partner_id)` (the
-- stripe_connect_credentials shape): the AND is true only in system scope,
-- and naming the helper keeps the rls-coverage partner-axis contract
-- (every DML command references breeze_has_partner_access) satisfied.
DROP POLICY IF EXISTS ai_model_registry_partner_cutover_access ON public.ai_model_registry_partner_cutover;
DROP POLICY IF EXISTS ai_model_registry_partner_cutover_select ON public.ai_model_registry_partner_cutover;
DROP POLICY IF EXISTS ai_model_registry_partner_cutover_insert ON public.ai_model_registry_partner_cutover;
DROP POLICY IF EXISTS ai_model_registry_partner_cutover_update ON public.ai_model_registry_partner_cutover;
DROP POLICY IF EXISTS ai_model_registry_partner_cutover_delete ON public.ai_model_registry_partner_cutover;
CREATE POLICY ai_model_registry_partner_cutover_select ON public.ai_model_registry_partner_cutover
  FOR SELECT
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );
CREATE POLICY ai_model_registry_partner_cutover_insert ON public.ai_model_registry_partner_cutover
  FOR INSERT
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  );
CREATE POLICY ai_model_registry_partner_cutover_update ON public.ai_model_registry_partner_cutover
  FOR UPDATE
  USING (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  );
CREATE POLICY ai_model_registry_partner_cutover_delete ON public.ai_model_registry_partner_cutover
  FOR DELETE
  USING (
    public.breeze_current_scope() = 'system'
    AND public.breeze_has_partner_access(partner_id)
  );
GRANT SELECT, INSERT, DELETE ON public.ai_model_registry_partner_cutover TO breeze_app;

DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  INSERT INTO public.ai_model_registry_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'created the ai_model_registry_state singleton (% row)', n; END IF;
END $$;
