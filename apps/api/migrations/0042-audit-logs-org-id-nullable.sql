-- Make audit_logs.org_id nullable to match Drizzle schema.
-- System-level events (admin password change, system login) have no org context.
ALTER TABLE audit_logs ALTER COLUMN org_id DROP NOT NULL;
