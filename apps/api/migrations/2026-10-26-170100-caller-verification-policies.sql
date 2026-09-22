-- Caller verification (anti-vishing) W01: inherited policies.
-- Dual-ownership config table (org_id XOR partner_id, Partner-Wide First,
-- epic #2135). Every policy field is nullable: NULL inherits from the partner
-- baseline, then from code defaults (baseline-then-tighten resolver).
--
-- Dual-axis RLS: one FOR ALL owner policy (system OR org OR partner access)
-- plus a separate SELECT-only branch so an org-scoped token can READ its
-- partner's baseline row but never mutate it.

CREATE TABLE IF NOT EXISTS caller_verification_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid REFERENCES organizations(id),
 partner_id uuid REFERENCES partners(id),
 required_tier_reset_password smallint CONSTRAINT cv_policy_reset_tier_chk CHECK(required_tier_reset_password BETWEEN 0 AND 3),
 required_tier_disable_user smallint CONSTRAINT cv_policy_disable_tier_chk CHECK(required_tier_disable_user BETWEEN 0 AND 3),
 disable_user_authorizer_roles text[],
 verification_ttl_minutes integer CONSTRAINT cv_policy_ttl_chk CHECK(verification_ttl_minutes BETWEEN 5 AND 240),
 allowed_methods text[] CONSTRAINT cv_policy_methods_chk CHECK(allowed_methods <@ ARRAY['workstation','sms','email','callback_attestation']::text[]),
 workstation_timeout_seconds integer CONSTRAINT cv_policy_timeout_chk CHECK(workstation_timeout_seconds BETWEEN 30 AND 300),
 destination_min_age_days integer CONSTRAINT cv_policy_age_chk CHECK(destination_min_age_days BETWEEN 0 AND 90),
 require_attested_destination boolean,
 require_ticket boolean,
 allow_cross_technician_use boolean,
 allow_administrative_disable boolean,
 max_attempts_per_hour smallint CONSTRAINT cv_policy_attempts_chk CHECK(max_attempts_per_hour BETWEEN 1 AND 100),
 cooling_off_hours integer CONSTRAINT cv_policy_cooling_chk CHECK(cooling_off_hours BETWEEN 1 AND 720),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 CONSTRAINT caller_verification_policies_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL)),
 CONSTRAINT cv_policy_org_uq UNIQUE(org_id),
 CONSTRAINT cv_policy_partner_uq UNIQUE(partner_id)
);
CREATE INDEX IF NOT EXISTS cv_policy_updated_by_idx ON caller_verification_policies(updated_by_user_id);

ALTER TABLE caller_verification_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE caller_verification_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cv_policy_owner ON caller_verification_policies;
CREATE POLICY cv_policy_owner ON caller_verification_policies FOR ALL
 USING (public.breeze_current_scope()='system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
 WITH CHECK (public.breeze_current_scope()='system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));

-- SELECT-only partner-wide read branch (template: 2026-10-05-110000-config-policy-partner-wide-select.sql).
-- Never fold this into the FOR ALL policy: that would widen UPDATE/DELETE
-- targeting to the partner baseline for org tokens.
DROP POLICY IF EXISTS cv_policy_partner_select ON caller_verification_policies;
CREATE POLICY cv_policy_partner_select ON caller_verification_policies
 FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
