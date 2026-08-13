-- Tenant variables (#3409 PR 1): a value defined once by an MSP and referenced
-- from scripts (PR 2) and software deployment (PR 2) instead of hardcoded per
-- customer — a SentinelOne site token, a Huntress org key, an internal package
-- repo URL, a syslog collector address.
--
-- Dual-axis config table (Partner-Wide First, epic #2135): a row is owned by
-- EITHER an org (org_id set, partner_id NULL) OR a partner (partner_id set,
-- org_id NULL — the "all orgs" template shape). Resolution precedence at
-- dispatch time (PR 2) is org > partner; when the site axis lands the order
-- becomes site > org > partner. Shape copied from
-- 2026-07-10-ticket-forms.sql + 2026-08-10-cis-baselines-partner-ownership.sql.
--
-- `value` always holds ciphertext written by services/tenantVariables.ts
-- (secretCrypto, AAD bound to the row id so a blob cannot be transplanted from
-- another tenant's row). It is NOT NULL with no default: a variable without a
-- value is meaningless. is_secret only controls whether the API is ever willing
-- to hand back the plaintext — encryption is unconditional either way.
--
-- Cascade leaf: nothing FK-references this table.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded CHECKs, CREATE INDEX IF NOT
-- EXISTS, DROP POLICY IF EXISTS then CREATE. Re-applying is a no-op. No inner
-- BEGIN/COMMIT (autoMigrate wraps each file in a transaction). No UPDATE/DELETE
-- cleanup here, so the GET DIAGNOSTICS ROW_COUNT reporting rule does not apply.

CREATE TABLE IF NOT EXISTS tenant_variables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  key varchar(64) NOT NULL,
  value text NOT NULL,
  is_secret boolean NOT NULL DEFAULT false,
  description varchar(500),
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Exactly one owner: org-scoped XOR partner-wide.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_variables_one_owner_chk'
      AND conrelid = 'tenant_variables'::regclass
  ) THEN
    ALTER TABLE tenant_variables
      ADD CONSTRAINT tenant_variables_one_owner_chk
      CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
END $$;

-- Key grammar is a DB-level contract, not just a Zod rule: PR 2 interpolates
-- the key into a {{var.<key>}} content token and into a BREEZE_VAR_<UPPER_KEY>
-- process env var name, so a key carrying whitespace, braces or '=' would
-- produce an unparseable token or an illegal env var name. Enforced here so no
-- write path — route, seed, backfill, psql — can introduce one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenant_variables_key_chk'
      AND conrelid = 'tenant_variables'::regclass
  ) THEN
    ALTER TABLE tenant_variables
      ADD CONSTRAINT tenant_variables_key_chk
      CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$');
  END IF;
END $$;

-- One key per owner. These are PARTIAL unique indexes rather than one UNIQUE
-- (org_id, partner_id, key): with one axis always NULL and NULL never equal to
-- NULL in a unique index, a combined constraint would never actually collide.
-- They also serve as the lookup indexes for the org_id / partner_id access and
-- cascade paths, so no separate single-column indexes are created.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_variables_org_key_uniq
  ON tenant_variables(org_id, key) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_variables_partner_key_uniq
  ON tenant_variables(partner_id, key) WHERE partner_id IS NOT NULL;

-- RLS: dual-axis (org-access OR partner-access OR system), one policy for all
-- four commands — mirrors 2026-07-10-ticket-forms.sql.
ALTER TABLE tenant_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_variables FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_variables_isolation ON tenant_variables;
CREATE POLICY tenant_variables_isolation
  ON tenant_variables
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

-- Read-only widening: an ORG-scoped session may SELECT the partner-wide
-- variables of its own partner. breeze_has_partner_access() is flat partner
-- access and is false for an org token, so without this branch an org admin
-- could not see the inherited variables that already apply to their own
-- devices — the settings list would read empty while dispatch (PR 2) still
-- resolved them. Writes are unaffected: permissive policies OR together and
-- this branch is FOR SELECT only. Same mechanism as
-- 2026-08-10-cis-baselines-partner-ownership.sql and
-- 2026-06-13-catalog-partner-read-branch.sql; kept as a SEPARATE policy so the
-- rls-coverage dual-axis assertion still sees a policy whose predicate names
-- breeze_has_partner_access for all four commands.
--
-- Agent contexts set currentPartnerId NULL (middleware/agentAuth.ts,
-- routes/agentWs.ts), so breeze_current_partner_id() is NULL there and this
-- branch exposes nothing to agents.
DROP POLICY IF EXISTS tenant_variables_partner_wide_select ON tenant_variables;
CREATE POLICY tenant_variables_partner_wide_select
  ON tenant_variables
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
