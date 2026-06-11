-- Tighten oauth_clients RLS so NULL partner_id shared DCR clients are not
-- globally visible/writable. Provider adapter paths use system DB context;
-- tenant visibility for shared clients comes through oauth_client_partner_grants.

BEGIN;

ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oauth_clients_partner_access ON oauth_clients;
DROP POLICY IF EXISTS oauth_clients_select_access ON oauth_clients;
DROP POLICY IF EXISTS oauth_clients_insert_access ON oauth_clients;
DROP POLICY IF EXISTS oauth_clients_update_access ON oauth_clients;
DROP POLICY IF EXISTS oauth_clients_delete_access ON oauth_clients;

CREATE POLICY oauth_clients_select_access ON oauth_clients
  FOR SELECT TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (
      partner_id IS NOT NULL
      AND public.breeze_has_partner_access(partner_id)
    )
    OR EXISTS (
      SELECT 1
      FROM oauth_client_partner_grants g
      WHERE g.client_id = oauth_clients.id
        AND public.breeze_has_partner_access(g.partner_id)
    )
  );

CREATE POLICY oauth_clients_insert_access ON oauth_clients
  FOR INSERT TO breeze_app
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (
      partner_id IS NOT NULL
      AND public.breeze_has_partner_access(partner_id)
    )
  );

CREATE POLICY oauth_clients_update_access ON oauth_clients
  FOR UPDATE TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (
      partner_id IS NOT NULL
      AND public.breeze_has_partner_access(partner_id)
    )
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (
      partner_id IS NOT NULL
      AND public.breeze_has_partner_access(partner_id)
    )
  );

CREATE POLICY oauth_clients_delete_access ON oauth_clients
  FOR DELETE TO breeze_app
  USING (
    public.breeze_current_scope() = 'system'
    OR (
      partner_id IS NOT NULL
      AND public.breeze_has_partner_access(partner_id)
    )
  );

COMMIT;
