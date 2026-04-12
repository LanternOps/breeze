-- 2026-04-12: Drop dead table policy_compliance
--
-- Audit confirmed this table is truly dead code:
--   - No Drizzle schema variable defined anywhere in apps/api/src/db/schema/
--   - Zero reads and zero writes anywhere in apps/api/src/
--   - Zero rows in production
--   - No other tables reference it via foreign key
--   - Superseded by automation_policy_compliance (schema in automations.ts,
--     actively used in routes, services, and RLS policies)
--
-- Originally created in the baseline migration (0001-baseline.sql).
-- Previously flagged for removal in 2026-04-11-bucket-c-dead-cleanup-rls.sql.
--
-- Fully idempotent (IF EXISTS).

DROP TABLE IF EXISTS policy_compliance;
