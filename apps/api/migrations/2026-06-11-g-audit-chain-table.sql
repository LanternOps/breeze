-- Issue #1002 (part 1 of 2): side table for the audit tamper-evidence chain.
--
-- The in-row chain (checksum/prev_checksum on audit_logs, PR #900) forks under
-- concurrent same-org inserts, and the obvious fix — an advisory lock held in
-- the BEFORE INSERT trigger — deadlocks against the codebase's two-connection
-- audit-write pattern (caller-tx insert + logSessionAudit on a separate pooled
-- connection; see draft PR #1240 and
-- docs/superpowers/specs/2026-06-11-audit-chain-deferred-sealing-design.md).
--
-- Linkage moves into this append-only side table, written by a DEFERRED
-- commit-time trigger (the -h- migration). chain_seq (bigserial) is the chain
-- order; per-org subsequences are walked by org_id + chain_seq. The companion
-- -h- migration installs the seal trigger, backfills existing rows, and
-- redefines audit_log_verify_chain over this table.

CREATE TABLE IF NOT EXISTS audit_log_chain (
  chain_seq bigserial PRIMARY KEY,
  audit_id uuid NOT NULL REFERENCES audit_logs(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE: chain entries are org-scoped metadata; orphans (audit rows removed via replica-role test cleanup or manual clearing) must not block org deletion. GDPR erasure still deletes chain rows explicitly first; audit_logs's own FK still blocks org deletes while audit rows exist.
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  content_checksum varchar(128) NOT NULL,
  prev_chain_checksum varchar(128),
  chain_checksum varchar(128) NOT NULL,
  sealed_at timestamptz NOT NULL DEFAULT now()
);

-- One seal per audit row; also serves the verify join and the unsealed-row sweep.
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_audit_id_uniq
  ON audit_log_chain (audit_id);

-- Head lookup in the seal function: WHERE org_id = $1 (or IS NULL) ORDER BY chain_seq DESC.
CREATE INDEX IF NOT EXISTS audit_log_chain_org_seq_idx
  ON audit_log_chain (org_id, chain_seq DESC);

-- Anti-fork hard guarantees (defense-in-depth — e.g. against a future
-- REPEATABLE READ caller whose commit-time head read could be stale):
-- (1) no two entries may chain off the same predecessor;
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_prev_uniq
  ON audit_log_chain (prev_chain_checksum)
  WHERE prev_chain_checksum IS NOT NULL;
-- (2) one genesis (prev IS NULL) per org chain (NULL org = the system chain).
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_genesis_uniq
  ON audit_log_chain ((COALESCE(org_id::text, 'NULL')))
  WHERE prev_chain_checksum IS NULL;

-- RLS: tenancy shape 1 (direct org_id) — the standard four policies, exactly
-- what rls-coverage.integration.test.ts auto-discovery expects. NULL-org rows
-- (system chain) are reachable only by system scope, mirroring audit_logs.
ALTER TABLE audit_log_chain ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log_chain FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_log_chain' AND policyname = 'breeze_org_isolation_select') THEN
    CREATE POLICY breeze_org_isolation_select ON public.audit_log_chain
      FOR SELECT USING (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_log_chain' AND policyname = 'breeze_org_isolation_insert') THEN
    CREATE POLICY breeze_org_isolation_insert ON public.audit_log_chain
      FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_log_chain' AND policyname = 'breeze_org_isolation_update') THEN
    CREATE POLICY breeze_org_isolation_update ON public.audit_log_chain
      FOR UPDATE USING (public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'audit_log_chain' AND policyname = 'breeze_org_isolation_delete') THEN
    CREATE POLICY breeze_org_isolation_delete ON public.audit_log_chain
      FOR DELETE USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;

-- Privileges: breeze_app may read and append, never mutate. Retention/erasure
-- DELETE via breeze_audit_admin (post-#915 a separate login credential), gated
-- additionally by the append-only trigger below. Nobody gets UPDATE: the
-- design never rewrites a chain entry (verify treats the first surviving
-- entry's prev as the trusted anchor after retention pruning — see the spec).
GRANT SELECT, INSERT ON TABLE audit_log_chain TO breeze_app;
REVOKE UPDATE, DELETE ON TABLE audit_log_chain FROM breeze_app;
GRANT USAGE ON SEQUENCE audit_log_chain_chain_seq_seq TO breeze_app;
GRANT SELECT, DELETE ON TABLE audit_log_chain TO breeze_audit_admin;
REVOKE UPDATE ON TABLE audit_log_chain FROM breeze_audit_admin;

-- Append-only enforcement, mirroring audit_log_immutable on audit_logs:
-- DELETE only under the retention GUC or via an FK cascade; UPDATE is NEVER
-- allowed (no re-anchor exists in this design — rewriting a sealed entry is
-- always tampering).
--
-- pg_trigger_depth() > 1 means this DELETE was issued by another trigger —
-- in practice the RI cascade from a parent-row delete (depth 2), since both
-- FKs here are ON DELETE CASCADE. Cascades are safe to admit: the audit_logs
-- parent is itself guarded by its own append-only trigger (so its rows only
-- die under the retention GUC anyway), and an organizations parent delete is
-- a total org erasure where blocking orphaned chain rows would be pointless
-- (GDPR cascade deletes chain rows explicitly first; this branch matters for
-- orphans left by replica-role test cleanup / manual audit clearing). A
-- direct SQL DELETE always runs the trigger at depth 1 and stays blocked.
CREATE OR REPLACE FUNCTION audit_log_chain_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allow_retention text := current_setting('breeze.allow_audit_retention', true);
BEGIN
  IF TG_OP = 'DELETE' AND (allow_retention = '1' OR pg_trigger_depth() > 1) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = 'audit log chain is append-only',
    HINT = 'audit_log_chain entries cannot be modified or deleted. Retention pruning and tenant erasure use breeze_audit_admin plus the breeze.allow_audit_retention GUC (DELETE only); see jobs/auditRetention.ts and services/tenantCascade.ts.';
END;
$$;

DROP TRIGGER IF EXISTS audit_log_chain_block_update ON audit_log_chain;
CREATE TRIGGER audit_log_chain_block_update BEFORE UPDATE ON audit_log_chain
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain_immutable();

DROP TRIGGER IF EXISTS audit_log_chain_block_delete ON audit_log_chain;
CREATE TRIGGER audit_log_chain_block_delete BEFORE DELETE ON audit_log_chain
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain_immutable();
