-- tickets:email_review (#10951): triage the inbound-email Review queue
-- (list, convert to a ticket, dismiss) without a '*:*' admin grant.
--
-- THIS MIGRATION GRANTS NO AUTHORITY TO ANY ROLE. Until now the queue routes
-- required platform admin or a '*:*' wildcard grant, and a wildcard row already
-- satisfies tickets:email_review at runtime (per-axis matching in
-- services/permissionMatching.ts), so every role that could review before still
-- can — Partner Admin included — with nothing to back-fill. Partners grant the
-- new permission to a custom role (or service account role) explicitly.
--
-- NOTE: `permissions` has NO UNIQUE constraint on (resource, action), so an
-- explicit existence check is used instead of a conflict-target upsert.
--
-- System scope first, as every migration that writes rows must (#4518).
SELECT set_config('breeze.scope', 'system', true);

-- The description MUST stay byte-identical to DEFAULT_PERMISSIONS in
-- apps/api/src/db/seed.ts.
INSERT INTO permissions (resource, action, description)
SELECT 'tickets', 'email_review', 'Review the inbound email queue: list, convert to a ticket, and dismiss quarantined or failed emails'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'tickets' AND action = 'email_review'
);
