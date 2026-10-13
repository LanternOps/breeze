-- #7971: restore `server` on devices that network discovery demoted before #8034.
--
-- Until #8034, an auto-linked discovered asset copied its port-scan type onto
-- devices.device_role over an agent-detected role. The agent's port-scan
-- classifier calls any RDP/SMB host without SSH a `workstation`, so Windows
-- Servers (domain controllers included) were demoted with
-- device_role_source = 'discovery'. The demotion sticks: the heartbeat only
-- re-applies the agent's role while the source is 'auto'. #8034 stopped new
-- demotions; this data-only migration repairs the rows already demoted.
--
-- WHICH ROWS. The role was last written by discovery, and the agent's own OS
-- fact says server: os_version contains "server" or "datacenter". That is step
-- 1, the highest-precedence step, of the agent's ClassifyDeviceRole
-- (agent/internal/collectors/classify.go). The agent's later steps (chassis
-- type, model, Linux systemd target) are not stored on the device row, so a
-- device that is a server only by those is ambiguous here and is left alone.
-- A technician's ('manual') or Fleet Design ('ai') role is never touched: the
-- predicate admits only source 'discovery'. Nothing is inferred from discovery.
-- A row that discovery already set to 'server' is included too: its role is
-- right, but while the source is 'discovery' the next scan may still demote
-- it (#8034 lets discovery overwrite its own writes), so its source is fixed.
--
-- WHAT CHANGES. Both columns: device_role = 'server' and
-- device_role_source = 'auto'. Leaving the source as 'discovery' would let the
-- next scan demote the device again; 'auto' + a real role is exactly what
-- #8034's allowlist protects, and it returns the row to agent-owned tracking:
-- later agent-reported role changes apply again, subject to the heartbeat's
-- privileged-flip guard. (That guard is also why the heartbeat could not have
-- restored 'server' by itself even with the source reset.)
-- Each repaired device gets one audit_logs row (action device.role.repaired,
-- details.source = 'repair-7971', old role -> new role) in this transaction.
--
-- WHY A MIGRATION. The production API image (docker/Dockerfile.api) ships the
-- compiled dist/ and migrations/, not src/ or scripts/, so a one-off script
-- would never reach Docker or self-hosted installs, which is where this bug
-- was reported.
--
-- Role-filtered configuration policies resolve device_role at read time, so
-- they pick the device back up immediately. Materialized dynamic-group
-- membership refreshes on the device's next filterable change (e.g. the
-- os_build bump from its next cumulative update) or a manual group re-save.
--
-- Idempotent: a repaired row no longer matches (its source is now 'auto'),
-- so a re-run updates and audits nothing.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
  lock_orgs uuid[];
  lock_partners uuid[];
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  -- Partner-export pre-locks (migrations/README.md; enforced by
  -- migrationPartnerExportLocks.test.ts, #5360; configuration family #5912).
  -- `devices` carries both device-material and configuration-material
  -- statement triggers, so take the stricter configuration family: every
  -- partner the UPDATE touches exclusive, then those orgs, each set sorted,
  -- before the first write. Empty arrays (nothing to repair) are a no-op.
  SELECT
    COALESCE(array_agg(DISTINCT o.id ORDER BY o.id), ARRAY[]::uuid[]),
    COALESCE(array_agg(DISTINCT o.partner_id ORDER BY o.partner_id)
               FILTER (WHERE o.partner_id IS NOT NULL), ARRAY[]::uuid[])
    INTO lock_orgs, lock_partners
    FROM public.devices d
    JOIN public.organizations o ON o.id = d.org_id
   WHERE d.device_role_source = 'discovery'
     AND (lower(d.os_version) LIKE '%server%' OR lower(d.os_version) LIKE '%datacenter%');
  PERFORM public.breeze_partner_export_lock_partners_exclusive(lock_partners);
  PERFORM public.breeze_partner_export_lock_orgs_under_exclusive_partners(lock_orgs, lock_partners);

  WITH repaired AS (
    UPDATE public.devices d
       SET device_role = 'server',
           device_role_source = 'auto',
           updated_at = now()
      FROM public.devices prev
     WHERE prev.id = d.id
       AND d.device_role_source = 'discovery'
         AND (lower(d.os_version) LIKE '%server%' OR lower(d.os_version) LIKE '%datacenter%')
    RETURNING d.id, d.org_id, d.hostname, d.os_version, prev.device_role AS from_role
  )
  INSERT INTO public.audit_logs (
    org_id, actor_type, actor_id, action, resource_type, resource_id, resource_name,
    result, initiated_by, details
  )
  SELECT r.org_id, 'system', '00000000-0000-0000-0000-000000000000', 'device.role.repaired',
         'device', r.id, r.hostname, 'success', 'automation',
         jsonb_build_object(
           'from', r.from_role,
           'to', 'server',
           'previousSource', 'discovery',
           'newSource', 'auto',
           'source', 'repair-7971',
           'osVersion', r.os_version,
           'issue', 7971
         )
    FROM repaired r;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING '#7971: restored device_role=server on % discovery-demoted device(s)', n;
  END IF;
END $$;
