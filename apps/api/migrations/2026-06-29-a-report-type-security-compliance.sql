-- Add the Security & Compliance Posture report type.
-- ALTER TYPE ... ADD VALUE is the ONLY statement in this file: under autoMigrate's
-- per-file transaction the new label is uncommitted until the file commits, so no
-- later statement here may use it. IF NOT EXISTS makes re-application a no-op.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'security_compliance_posture';
