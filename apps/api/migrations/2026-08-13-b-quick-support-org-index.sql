-- Quick Support — partial unique index on the new org_type enum value.
--
-- MUST be a separate file from -a-: Postgres forbids USING an enum value that
-- was added in the current transaction (55P04 "unsafe use of new value"), and
-- autoMigrate wraps each migration file in ONE transaction. File -a- commits
-- the 'quick_support' value; this file is then free to reference it.
--
-- Enforces exactly one hidden Quick Support org per partner, which is what
-- makes getOrCreateQuickSupportOrg()'s onConflictDoNothing + re-select safe
-- against a concurrent-create race.
--
-- Idempotent. No inner BEGIN/COMMIT.

CREATE UNIQUE INDEX IF NOT EXISTS organizations_partner_quick_support_uniq
  ON organizations(partner_id) WHERE type = 'quick_support';
