-- Cleanup of unused tables/columns from the deleted mcpBootstrap module.
-- See docs/superpowers/plans/2026-04-29-mcp-bootstrap-cleanup.md for context.
--
-- Idempotent (per CLAUDE.md migration rules). Safe to apply multiple times.

-- 1) Drop partner_activations: every reference came from activationRoutes.ts,
--    which was deleted in Phase 4. RLS policies are dropped automatically with
--    the table.
DROP TABLE IF EXISTS partner_activations;

-- 2) Drop api_keys.scope_state. The 'readonly' value was only ever set by the
--    deleted verify_tenant tool during pending_payment; no live caller produces
--    'readonly' keys anymore. partnerGuard now governs whether tools work at
--    all (active vs pending/suspended), so a per-key scope is redundant.
ALTER TABLE api_keys DROP COLUMN IF EXISTS scope_state;

-- Intentionally KEEP on partners:
--   - mcp_origin, mcp_origin_ip, mcp_origin_user_agent: useful audit trail
--   - email_verified_at: still useful for future email-verification flows
--   - payment_method_attached_at: kept as a denormalized timestamp that
--     breeze-billing populates via the activate callback
--   - stripe_customer_id: used by breeze-billing for customer lookups
--
-- Intentionally KEEP table deployment_invites: still used by the surviving
-- send_deployment_invites tool.
