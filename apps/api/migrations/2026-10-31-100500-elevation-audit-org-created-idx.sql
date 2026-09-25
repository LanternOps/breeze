-- #4910: keyset traversal index for GET /pam/elevation-audit/export, which
-- pages one org's PAM event ledger in recorded (created_at, id) order. The
-- existing indexes cover (elevation_request_id, occurred_at) and org_id
-- alone, neither of which serves an ordered per-org scan. Index-only; no rows
-- are written.
CREATE INDEX IF NOT EXISTS elevation_audit_org_created_id_idx
  ON elevation_audit (org_id, created_at, id);
