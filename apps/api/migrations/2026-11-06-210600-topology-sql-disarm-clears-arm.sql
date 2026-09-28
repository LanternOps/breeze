-- PR #7117 (M3 Task 7 follow-up): the two SQL disarm paths must clear the M3
-- arm exactly like the application's disarmPolicyRow (monitoringPolicyState.ts).
--
-- topology_monitoring_policies_armed_chk only binds ENABLED rows, so the M1
-- detach backstop (inventory moved/deleted) and the template unbind guard kept
-- passing after M3 added the arm columns — but they left the frozen requester
-- actor, the permission witness, armed_at, the routing contexts and the next
-- slot behind on a DISABLED row. That row then reads as "armed at <time>" in
-- the policy/configuration read models and retains a frozen authority snapshot
-- nobody can act on. Clearing them makes a SQL disarm indistinguishable from an
-- app disarm: re-enabling always needs a fresh human arm.
--
-- Function bodies are the shipped M1 bodies (2026-10-24-110100 / -110200) plus
-- the arm columns; CREATE OR REPLACE is idempotent. Schema only; no rows are
-- written.

CREATE OR REPLACE FUNCTION breeze_detach_topology_monitor_authority(
 p_kind text, p_inventory_id uuid, p_org_id uuid, p_site_id uuid, p_reason text
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE monitor_ids uuid[]; node_ids uuid[];
BEGIN
 SELECT coalesce(array_agg(node_id),'{}'::uuid[]) INTO node_ids FROM topology_node_bindings
 WHERE org_id=p_org_id AND site_id=p_site_id AND
 ((p_kind='asset' AND discovered_asset_id=p_inventory_id) OR (p_kind='device' AND device_id=p_inventory_id));
 SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO monitor_ids FROM network_monitors
 WHERE p_kind='asset' AND org_id=p_org_id AND asset_id=p_inventory_id;
 UPDATE topology_monitoring_policies SET enabled=false, authority_digest=NULL,
  authority_actor=NULL, authority_permission_version=NULL, armed_at=NULL, routing_contexts='[]'::jsonb, next_scheduled_at=NULL,
  authority_generation=authority_generation+1, blocked_reason=p_reason, updated_at=now()
 WHERE org_id=p_org_id AND site_id=p_site_id AND
 (subject_node_id=ANY(node_ids) OR id IN (SELECT policy_id FROM topology_monitor_bindings WHERE org_id=p_org_id AND site_id=p_site_id AND monitor_id=ANY(monitor_ids)));
 UPDATE topology_diagnostic_runs SET cancel_requested_at=coalesce(cancel_requested_at,now()),
  state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END,
  failure_reason=p_reason, finished_at=CASE WHEN state='queued' THEN now() ELSE finished_at END, updated_at=now()
 WHERE org_id=p_org_id AND site_id=p_site_id AND state IN ('queued','running') AND
 (origin_node_id=ANY(node_ids) OR subject_node_id=ANY(node_ids) OR (p_kind='device' AND origin_snapshot->>'deviceId'=p_inventory_id::text));
 UPDATE device_commands SET status='cancelled', completed_at=now()
 WHERE status='pending' AND id IN (SELECT command_id FROM topology_diagnostic_runs
 WHERE org_id=p_org_id AND site_id=p_site_id AND state='cancelled' AND failure_reason=p_reason);
 DELETE FROM topology_monitor_bindings WHERE org_id=p_org_id AND site_id=p_site_id AND (monitor_id=ANY(monitor_ids) OR node_id=ANY(node_ids));
 UPDATE network_monitors SET is_active=false, asset_id=NULL, updated_at=now()
 WHERE org_id=p_org_id AND id=ANY(monitor_ids);
END $$;

CREATE OR REPLACE FUNCTION breeze_topology_template_unbind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (OLD.partner_version_id IS NOT NULL AND NEW.partner_version_id IS NULL) OR (OLD.org_version_id IS NOT NULL AND NEW.org_version_id IS NULL) THEN
  IF TG_TABLE_NAME='topology_site_template_bindings' THEN
   NEW.effective_digest=NULL;NEW.status='requires_rearm';NEW.revision=OLD.revision+1;
   UPDATE topology_monitoring_policies SET enabled=false,authority_digest=NULL,
    authority_actor=NULL,authority_permission_version=NULL,armed_at=NULL,routing_contexts='[]'::jsonb,next_scheduled_at=NULL,
    authority_generation=authority_generation+1,blocked_reason='template_removed',updated_at=now(),configuration_digest=NULL,
    partner_version_id=CASE WHEN OLD.partner_version_id IS NOT NULL AND NEW.partner_version_id IS NULL AND partner_version_id=OLD.partner_version_id THEN NULL ELSE partner_version_id END,
    org_version_id=CASE WHEN OLD.org_version_id IS NOT NULL AND NEW.org_version_id IS NULL AND org_version_id=OLD.org_version_id THEN NULL ELSE org_version_id END
    WHERE org_id=OLD.org_id AND site_id=OLD.site_id;
   UPDATE topology_diagnostic_runs SET state='cancelled',finished_at=now(),cancel_requested_at=now(),failure_reason='template_removed',updated_at=now() WHERE org_id=OLD.org_id AND site_id=OLD.site_id AND state='queued';
  ELSE
   NEW.configuration_digest=NULL;NEW.enabled=false;
   IF TG_TABLE_NAME='topology_monitoring_policies' THEN NEW.authority_digest=NULL;NEW.authority_generation=OLD.authority_generation+1;NEW.blocked_reason='template_removed';
    NEW.authority_actor=NULL;NEW.authority_permission_version=NULL;NEW.armed_at=NULL;NEW.routing_contexts='[]'::jsonb;NEW.next_scheduled_at=NULL; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
