-- Follow-on to 2026-04-20-mcp-bootstrap-schema.sql:
-- deployment_invites was initially shipped with a partner-only RLS policy,
-- but the table carries both partner_id and org_id (shape 4, dual-axis).
-- Replace the partner-only policy with a dual-axis policy so org-level
-- callers (site/org admins) can see invites for their org while partner
-- admins retain visibility across the whole partner.

DROP POLICY IF EXISTS deployment_invites_partner_access ON deployment_invites;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'deployment_invites_dual_axis_access') THEN
    CREATE POLICY deployment_invites_dual_axis_access ON deployment_invites
      USING (breeze_has_partner_access(partner_id) OR breeze_has_org_access(org_id))
      WITH CHECK (breeze_has_partner_access(partner_id) OR breeze_has_org_access(org_id));
  END IF;
END $$;
