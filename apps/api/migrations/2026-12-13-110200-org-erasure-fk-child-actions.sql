-- @no-transaction
-- Org erasure: ON DELETE actions for the remaining FK-only child edges an
-- ordinary, in-use org reaches.
--
-- Every table altered here has no org_id of its own, so cascadeDeleteOrg()
-- (services/tenantCascade.ts) never deletes from it directly, yet each holds
-- a foreign key declared without an ON DELETE action (NO ACTION) into a table
-- the erasure walk DOES delete from: devices, alerts, tickets, users, roles,
-- ai_sessions, patch_jobs, deployments, automations, notification channels,
-- maintenance windows, refresh-token families, ... The first such row -- a
-- patched or deployed device, an alert notification, a ticket comment, an AI
-- chat, an interactive login session, a custom role's permissions -- made
-- erasure abort with 23503 part-way through the walk, leaving the tenant
-- half-erased. These edges were carried as accepted debt in
-- ORG_CASCADE_FK_UNSAFE (src/__tests__/integration/orgCascadeFkOnDeleteAllowlist.ts);
-- this migration retires them. Proven end to end by
-- tenantCascadeFkChildren.integration.test.ts.
--
-- The action per edge:
--   CASCADE  -- the child row is meaningless without its parent (per-device
--               results/compliance/rollbacks, alert notifications of a
--               deleted alert, alert correlations, ticket comments, AI
--               messages and tool runs, automation runs, maintenance
--               occurrences, role permissions, a deleted user's access-review
--               items, login sessions, add-in bindings and token-exchange
--               grants, ...).
--   SET NULL -- a nullable attribution or back-reference on a row that has
--               its own owner and must survive (created_by / connected_by /
--               approved_by / verified_by on partner-level integrations and
--               records, a rollback's originating job, the author of a
--               ticket comment, an approval's requesting OAuth session, an
--               AI tool execution's originating message (the execution
--               itself goes with its session), an alert notification's
--               channel (delivery history outlives a deleted channel; the
--               column is made nullable for it), an auth browser
--               transition's current family -- both of that composite FK's
--               columns are nullable and must be NULL together, which is
--               exactly what SET NULL does).
--
-- Deliberately NOT changed (still pinned or pre-cleared on the ledger, each
-- with a note): access_review_items.role_id keeps NO ACTION -- a completed
-- review's items are evidence and must not vanish when the reviewed role is
-- deleted later; the role-delete route answers 409 instead, and org erasure
-- clears the org's role items explicitly (ASSOCIATED_SYSTEM_SCOPED_TABLES);
-- edges whose child carries UPDATE triggers that a SET NULL would fire
-- (config_policy_assignments, config_policy_compliance_rules, patch_policies,
-- script_versions); NOT NULL attributions on partner credentials
-- (partner_service_principals, partner_service_principal_keys -- CASCADE
-- would delete a partner's credential because its creator left); and
-- partner_users.role_id (a partner membership must not disappear because a
-- role was deleted).
--
-- Referential actions run with row security disabled, so these fire
-- regardless of the children's RLS policies. No row is written here.
--
-- Locking. Several parents (devices, alerts, users, tickets, roles) take
-- writes on every heartbeat / request, and several children are large. So,
-- outside a transaction:
--   1. per table, one ALTER TABLE swaps each constraint NOT VALID (catalog
--      only, no scan). Dropping an FK removes its RI triggers from BOTH
--      tables, so this takes ACCESS EXCLUSIVE on the child AND on the parent
--      (users, devices, alerts, tickets, ...) for the duration of the
--      statement -- brief once granted, but it conflicts with every reader
--      too, and a lock request queued behind a long-running transaction
--      (a report, a pg_dump/backup) blocks every later reader and writer of
--      that table. lock_timeout bounds the wait: the statement fails after
--      5s instead of stalling heartbeats, autoMigrate aborts boot, and the
--      file re-runs cleanly on the next start. The replaced constraint
--      already guaranteed every existing row is valid; a NOT VALID FK still
--      checks new rows and still fires its ON DELETE action;
--   2. VALIDATE each constraint separately, which takes only
--      SHARE UPDATE EXCLUSIVE on the child and ROW SHARE on the parent, so
--      writes continue during the scan.
-- lock_timeout is set per session here (each statement is sent on its own)
-- and RESET at the end so it does not leak into later migrations.
--
-- Idempotent: re-applying re-swaps and re-validates the same definitions. An
-- interruption part-way leaves enforcing NOT VALID constraints that the next
-- run validates.

SET lock_timeout = '5s';

-- 1. Swap each FK NOT VALID with its ON DELETE action.
ALTER TABLE public.access_review_items
  DROP CONSTRAINT IF EXISTS access_review_items_reviewed_by_users_id_fk,
  ADD CONSTRAINT access_review_items_reviewed_by_users_id_fk
    FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID,
  DROP CONSTRAINT IF EXISTS access_review_items_user_id_users_id_fk,
  ADD CONSTRAINT access_review_items_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.accounting_connections
  DROP CONSTRAINT IF EXISTS accounting_connections_connected_by_fkey,
  ADD CONSTRAINT accounting_connections_connected_by_fkey
    FOREIGN KEY (connected_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.ai_messages
  DROP CONSTRAINT IF EXISTS ai_messages_session_id_ai_sessions_id_fk,
  ADD CONSTRAINT ai_messages_session_id_ai_sessions_id_fk
    FOREIGN KEY (session_id) REFERENCES public.ai_sessions(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.ai_tool_executions
  DROP CONSTRAINT IF EXISTS ai_tool_executions_approved_by_users_id_fk,
  ADD CONSTRAINT ai_tool_executions_approved_by_users_id_fk
    FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID,
  DROP CONSTRAINT IF EXISTS ai_tool_executions_session_id_ai_sessions_id_fk,
  ADD CONSTRAINT ai_tool_executions_session_id_ai_sessions_id_fk
    FOREIGN KEY (session_id) REFERENCES public.ai_sessions(id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT IF EXISTS ai_tool_executions_message_id_ai_messages_id_fk,
  ADD CONSTRAINT ai_tool_executions_message_id_ai_messages_id_fk
    FOREIGN KEY (message_id) REFERENCES public.ai_messages(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.alert_correlations
  DROP CONSTRAINT IF EXISTS alert_correlations_child_alert_id_alerts_id_fk,
  ADD CONSTRAINT alert_correlations_child_alert_id_alerts_id_fk
    FOREIGN KEY (child_alert_id) REFERENCES public.alerts(id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT IF EXISTS alert_correlations_parent_alert_id_alerts_id_fk,
  ADD CONSTRAINT alert_correlations_parent_alert_id_alerts_id_fk
    FOREIGN KEY (parent_alert_id) REFERENCES public.alerts(id) ON DELETE CASCADE NOT VALID;

-- channel_id becomes nullable (catalog-only, no scan) so deleting a channel
-- -- possibly a partner-wide one shared by every org -- keeps the delivery
-- history of every alert it ever paged, unlinked, instead of erasing it.
ALTER TABLE public.alert_notifications
  ALTER COLUMN channel_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS alert_notifications_alert_id_alerts_id_fk,
  ADD CONSTRAINT alert_notifications_alert_id_alerts_id_fk
    FOREIGN KEY (alert_id) REFERENCES public.alerts(id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT IF EXISTS alert_notifications_channel_id_notification_channels_id_fk,
  ADD CONSTRAINT alert_notifications_channel_id_notification_channels_id_fk
    FOREIGN KEY (channel_id) REFERENCES public.notification_channels(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_requesting_session_id_fkey,
  ADD CONSTRAINT approval_requests_requesting_session_id_fkey
    FOREIGN KEY (requesting_session_id) REFERENCES public.oauth_sessions(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.auth_browser_transitions
  DROP CONSTRAINT IF EXISTS auth_browser_transitions_current_family_owner_fk,
  ADD CONSTRAINT auth_browser_transitions_current_family_owner_fk
    FOREIGN KEY (current_family_id, current_user_id) REFERENCES public.refresh_token_families(family_id, user_id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.authenticator_policies
  DROP CONSTRAINT IF EXISTS authenticator_policies_updated_by_user_id_fkey,
  ADD CONSTRAINT authenticator_policies_updated_by_user_id_fkey
    FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.automation_policy_compliance
  DROP CONSTRAINT IF EXISTS automation_policy_compliance_device_id_devices_id_fk,
  ADD CONSTRAINT automation_policy_compliance_device_id_devices_id_fk
    FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT IF EXISTS automation_policy_compliance_policy_id_automation_policies_id_f,
  ADD CONSTRAINT automation_policy_compliance_policy_id_automation_policies_id_f
    FOREIGN KEY (policy_id) REFERENCES public.automation_policies(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.automation_runs
  DROP CONSTRAINT IF EXISTS automation_runs_automation_id_automations_id_fk,
  ADD CONSTRAINT automation_runs_automation_id_automations_id_fk
    FOREIGN KEY (automation_id) REFERENCES public.automations(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.catalog_items
  DROP CONSTRAINT IF EXISTS catalog_items_created_by_fkey,
  ADD CONSTRAINT catalog_items_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.dashboard_widgets
  DROP CONSTRAINT IF EXISTS dashboard_widgets_dashboard_id_analytics_dashboards_id_fk,
  ADD CONSTRAINT dashboard_widgets_dashboard_id_analytics_dashboards_id_fk
    FOREIGN KEY (dashboard_id) REFERENCES public.analytics_dashboards(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.deployment_devices
  DROP CONSTRAINT IF EXISTS deployment_devices_deployment_id_deployments_id_fk,
  ADD CONSTRAINT deployment_devices_deployment_id_deployments_id_fk
    FOREIGN KEY (deployment_id) REFERENCES public.deployments(id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT IF EXISTS deployment_devices_device_id_devices_id_fk,
  ADD CONSTRAINT deployment_devices_device_id_devices_id_fk
    FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.maintenance_occurrences
  DROP CONSTRAINT IF EXISTS maintenance_occurrences_window_id_maintenance_windows_id_fk,
  ADD CONSTRAINT maintenance_occurrences_window_id_maintenance_windows_id_fk
    FOREIGN KEY (window_id) REFERENCES public.maintenance_windows(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.network_known_guests
  DROP CONSTRAINT IF EXISTS network_known_guests_added_by_users_id_fk,
  ADD CONSTRAINT network_known_guests_added_by_users_id_fk
    FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.office_addin_user_bindings
  DROP CONSTRAINT IF EXISTS office_addin_bindings_user_partner_fk,
  ADD CONSTRAINT office_addin_bindings_user_partner_fk
    FOREIGN KEY (user_id, partner_id) REFERENCES public.users(id, partner_id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT IF EXISTS office_addin_user_bindings_revoked_by_fkey,
  ADD CONSTRAINT office_addin_user_bindings_revoked_by_fkey
    FOREIGN KEY (revoked_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID,
  DROP CONSTRAINT IF EXISTS office_addin_user_bindings_user_id_fkey,
  ADD CONSTRAINT office_addin_user_bindings_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.patch_approvals
  DROP CONSTRAINT IF EXISTS patch_approvals_approved_by_users_id_fk,
  ADD CONSTRAINT patch_approvals_approved_by_users_id_fk
    FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.patch_job_results
  DROP CONSTRAINT IF EXISTS patch_job_results_device_id_devices_id_fk,
  ADD CONSTRAINT patch_job_results_device_id_devices_id_fk
    FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT IF EXISTS patch_job_results_job_id_patch_jobs_id_fk,
  ADD CONSTRAINT patch_job_results_job_id_patch_jobs_id_fk
    FOREIGN KEY (job_id) REFERENCES public.patch_jobs(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.patch_rollbacks
  DROP CONSTRAINT IF EXISTS patch_rollbacks_device_id_devices_id_fk,
  ADD CONSTRAINT patch_rollbacks_device_id_devices_id_fk
    FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT IF EXISTS patch_rollbacks_initiated_by_users_id_fk,
  ADD CONSTRAINT patch_rollbacks_initiated_by_users_id_fk
    FOREIGN KEY (initiated_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID,
  DROP CONSTRAINT IF EXISTS patch_rollbacks_original_job_id_patch_jobs_id_fk,
  ADD CONSTRAINT patch_rollbacks_original_job_id_patch_jobs_id_fk
    FOREIGN KEY (original_job_id) REFERENCES public.patch_jobs(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.pax8_integrations
  DROP CONSTRAINT IF EXISTS pax8_integrations_created_by_fkey,
  ADD CONSTRAINT pax8_integrations_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.plugin_logs
  DROP CONSTRAINT IF EXISTS plugin_logs_installation_id_plugin_installations_id_fk,
  ADD CONSTRAINT plugin_logs_installation_id_plugin_installations_id_fk
    FOREIGN KEY (installation_id) REFERENCES public.plugin_installations(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.role_permissions
  DROP CONSTRAINT IF EXISTS role_permissions_role_id_roles_id_fk,
  ADD CONSTRAINT role_permissions_role_id_roles_id_fk
    FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.sessions
  DROP CONSTRAINT IF EXISTS sessions_user_id_users_id_fk,
  ADD CONSTRAINT sessions_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.snmp_alert_thresholds
  DROP CONSTRAINT IF EXISTS snmp_alert_thresholds_device_id_snmp_devices_id_fk,
  ADD CONSTRAINT snmp_alert_thresholds_device_id_snmp_devices_id_fk
    FOREIGN KEY (device_id) REFERENCES public.snmp_devices(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.software_compliance_status
  DROP CONSTRAINT IF EXISTS software_compliance_status_device_id_devices_id_fk,
  ADD CONSTRAINT software_compliance_status_device_id_devices_id_fk
    FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.sso_token_exchange_grants
  DROP CONSTRAINT IF EXISTS sso_token_exchange_grants_family_owner_fk,
  ADD CONSTRAINT sso_token_exchange_grants_family_owner_fk
    FOREIGN KEY (family_id, user_id) REFERENCES public.refresh_token_families(family_id, user_id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.stripe_connect_accounts
  DROP CONSTRAINT IF EXISTS stripe_connect_accounts_connected_by_fkey,
  ADD CONSTRAINT stripe_connect_accounts_connected_by_fkey
    FOREIGN KEY (connected_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.td_synnex_digital_bridge_integrations
  DROP CONSTRAINT IF EXISTS td_synnex_digital_bridge_integrations_created_by_fkey,
  ADD CONSTRAINT td_synnex_digital_bridge_integrations_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.td_synnex_ec_express_integrations
  DROP CONSTRAINT IF EXISTS td_synnex_ec_express_integrations_created_by_fkey,
  ADD CONSTRAINT td_synnex_ec_express_integrations_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.td_synnex_sftp_integrations
  DROP CONSTRAINT IF EXISTS td_synnex_sftp_integrations_created_by_fkey,
  ADD CONSTRAINT td_synnex_sftp_integrations_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.ticket_comments
  DROP CONSTRAINT IF EXISTS ticket_comments_portal_user_id_portal_users_id_fk,
  ADD CONSTRAINT ticket_comments_portal_user_id_portal_users_id_fk
    FOREIGN KEY (portal_user_id) REFERENCES public.portal_users(id) ON DELETE SET NULL NOT VALID,
  DROP CONSTRAINT IF EXISTS ticket_comments_ticket_id_tickets_id_fk,
  ADD CONSTRAINT ticket_comments_ticket_id_tickets_id_fk
    FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE NOT VALID,
  DROP CONSTRAINT IF EXISTS ticket_comments_user_id_users_id_fk,
  ADD CONSTRAINT ticket_comments_user_id_users_id_fk
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.ticket_mailbox_consent_sessions
  DROP CONSTRAINT IF EXISTS ticket_mailbox_consent_sessions_user_id_fkey,
  ADD CONSTRAINT ticket_mailbox_consent_sessions_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.ticket_mailbox_tenant_ownerships
  DROP CONSTRAINT IF EXISTS ticket_mailbox_tenant_ownerships_verified_by_fkey,
  ADD CONSTRAINT ticket_mailbox_tenant_ownerships_verified_by_fkey
    FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.ticket_response_templates
  DROP CONSTRAINT IF EXISTS ticket_response_templates_created_by_fkey,
  ADD CONSTRAINT ticket_response_templates_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.unifi_integrations
  DROP CONSTRAINT IF EXISTS unifi_integrations_created_by_fkey,
  ADD CONSTRAINT unifi_integrations_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL NOT VALID;

-- 2. Validate (no write-blocking locks).
ALTER TABLE public.access_review_items VALIDATE CONSTRAINT access_review_items_reviewed_by_users_id_fk;
ALTER TABLE public.access_review_items VALIDATE CONSTRAINT access_review_items_user_id_users_id_fk;
ALTER TABLE public.accounting_connections VALIDATE CONSTRAINT accounting_connections_connected_by_fkey;
ALTER TABLE public.ai_messages VALIDATE CONSTRAINT ai_messages_session_id_ai_sessions_id_fk;
ALTER TABLE public.ai_tool_executions VALIDATE CONSTRAINT ai_tool_executions_approved_by_users_id_fk;
ALTER TABLE public.ai_tool_executions VALIDATE CONSTRAINT ai_tool_executions_session_id_ai_sessions_id_fk;
ALTER TABLE public.ai_tool_executions VALIDATE CONSTRAINT ai_tool_executions_message_id_ai_messages_id_fk;
ALTER TABLE public.alert_correlations VALIDATE CONSTRAINT alert_correlations_child_alert_id_alerts_id_fk;
ALTER TABLE public.alert_correlations VALIDATE CONSTRAINT alert_correlations_parent_alert_id_alerts_id_fk;
ALTER TABLE public.alert_notifications VALIDATE CONSTRAINT alert_notifications_alert_id_alerts_id_fk;
ALTER TABLE public.alert_notifications VALIDATE CONSTRAINT alert_notifications_channel_id_notification_channels_id_fk;
ALTER TABLE public.approval_requests VALIDATE CONSTRAINT approval_requests_requesting_session_id_fkey;
ALTER TABLE public.auth_browser_transitions VALIDATE CONSTRAINT auth_browser_transitions_current_family_owner_fk;
ALTER TABLE public.authenticator_policies VALIDATE CONSTRAINT authenticator_policies_updated_by_user_id_fkey;
ALTER TABLE public.automation_policy_compliance VALIDATE CONSTRAINT automation_policy_compliance_device_id_devices_id_fk;
ALTER TABLE public.automation_policy_compliance VALIDATE CONSTRAINT automation_policy_compliance_policy_id_automation_policies_id_f;
ALTER TABLE public.automation_runs VALIDATE CONSTRAINT automation_runs_automation_id_automations_id_fk;
ALTER TABLE public.catalog_items VALIDATE CONSTRAINT catalog_items_created_by_fkey;
ALTER TABLE public.dashboard_widgets VALIDATE CONSTRAINT dashboard_widgets_dashboard_id_analytics_dashboards_id_fk;
ALTER TABLE public.deployment_devices VALIDATE CONSTRAINT deployment_devices_deployment_id_deployments_id_fk;
ALTER TABLE public.deployment_devices VALIDATE CONSTRAINT deployment_devices_device_id_devices_id_fk;
ALTER TABLE public.maintenance_occurrences VALIDATE CONSTRAINT maintenance_occurrences_window_id_maintenance_windows_id_fk;
ALTER TABLE public.network_known_guests VALIDATE CONSTRAINT network_known_guests_added_by_users_id_fk;
ALTER TABLE public.office_addin_user_bindings VALIDATE CONSTRAINT office_addin_bindings_user_partner_fk;
ALTER TABLE public.office_addin_user_bindings VALIDATE CONSTRAINT office_addin_user_bindings_revoked_by_fkey;
ALTER TABLE public.office_addin_user_bindings VALIDATE CONSTRAINT office_addin_user_bindings_user_id_fkey;
ALTER TABLE public.patch_approvals VALIDATE CONSTRAINT patch_approvals_approved_by_users_id_fk;
ALTER TABLE public.patch_job_results VALIDATE CONSTRAINT patch_job_results_device_id_devices_id_fk;
ALTER TABLE public.patch_job_results VALIDATE CONSTRAINT patch_job_results_job_id_patch_jobs_id_fk;
ALTER TABLE public.patch_rollbacks VALIDATE CONSTRAINT patch_rollbacks_device_id_devices_id_fk;
ALTER TABLE public.patch_rollbacks VALIDATE CONSTRAINT patch_rollbacks_initiated_by_users_id_fk;
ALTER TABLE public.patch_rollbacks VALIDATE CONSTRAINT patch_rollbacks_original_job_id_patch_jobs_id_fk;
ALTER TABLE public.pax8_integrations VALIDATE CONSTRAINT pax8_integrations_created_by_fkey;
ALTER TABLE public.plugin_logs VALIDATE CONSTRAINT plugin_logs_installation_id_plugin_installations_id_fk;
ALTER TABLE public.role_permissions VALIDATE CONSTRAINT role_permissions_role_id_roles_id_fk;
ALTER TABLE public.sessions VALIDATE CONSTRAINT sessions_user_id_users_id_fk;
ALTER TABLE public.snmp_alert_thresholds VALIDATE CONSTRAINT snmp_alert_thresholds_device_id_snmp_devices_id_fk;
ALTER TABLE public.software_compliance_status VALIDATE CONSTRAINT software_compliance_status_device_id_devices_id_fk;
ALTER TABLE public.sso_token_exchange_grants VALIDATE CONSTRAINT sso_token_exchange_grants_family_owner_fk;
ALTER TABLE public.stripe_connect_accounts VALIDATE CONSTRAINT stripe_connect_accounts_connected_by_fkey;
ALTER TABLE public.td_synnex_digital_bridge_integrations VALIDATE CONSTRAINT td_synnex_digital_bridge_integrations_created_by_fkey;
ALTER TABLE public.td_synnex_ec_express_integrations VALIDATE CONSTRAINT td_synnex_ec_express_integrations_created_by_fkey;
ALTER TABLE public.td_synnex_sftp_integrations VALIDATE CONSTRAINT td_synnex_sftp_integrations_created_by_fkey;
ALTER TABLE public.ticket_comments VALIDATE CONSTRAINT ticket_comments_portal_user_id_portal_users_id_fk;
ALTER TABLE public.ticket_comments VALIDATE CONSTRAINT ticket_comments_ticket_id_tickets_id_fk;
ALTER TABLE public.ticket_comments VALIDATE CONSTRAINT ticket_comments_user_id_users_id_fk;
ALTER TABLE public.ticket_mailbox_consent_sessions VALIDATE CONSTRAINT ticket_mailbox_consent_sessions_user_id_fkey;
ALTER TABLE public.ticket_mailbox_tenant_ownerships VALIDATE CONSTRAINT ticket_mailbox_tenant_ownerships_verified_by_fkey;
ALTER TABLE public.ticket_response_templates VALIDATE CONSTRAINT ticket_response_templates_created_by_fkey;
ALTER TABLE public.unifi_integrations VALIDATE CONSTRAINT unifi_integrations_created_by_fkey;

RESET lock_timeout;
