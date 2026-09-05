/**
 * Foreign-key ledger for the GDPR org-erasure cascade (#4519).
 *
 * Enforced by `orgCascadeFkOnDelete.integration.test.ts`; that file's header
 * carries the full execution model. The short version: erasure empties a
 * tenant with a sequence of ordinary `DELETE` statements, so a foreign key
 * pointing at any table those statements touch is only safe if Postgres
 * clears it for us, or the referencing rows are already gone by the time that
 * statement runs. Anything else is an erasure failure that lies dormant until
 * a customer creates the first row in the referencing table -- exactly how
 * #4100 shipped.
 *
 * HOW TO USE THIS FILE
 *
 * You are here because the contract test failed. Do NOT reflexively add a
 * line. In order of preference:
 *
 *   1. Give the FK an explicit `ON DELETE` in a NEW, idempotent, fix-forward
 *      migration (never edit a shipped one). `CASCADE` when the child row is
 *      meaningless without the parent; `SET NULL` when it is an optional
 *      back-reference and `allColumnsNullable` is true. This is the answer for
 *      nearly every new FK.
 *   2. Register the child table in `CORE_ORG_CASCADE_DELETE_ORDER` -- plus
 *      every other list CLAUDE.md's cascade-registration table demands (device
 *      cascade, export policy, ...). Only valid if the child has its own
 *      `org_id`.
 *   3. Add an `ASSOCIATED_SYSTEM_SCOPED_TABLES` pre-clear in
 *      `services/tenantCascade.ts`, then record the FK in
 *      `ORG_CASCADE_FK_PRE_CLEARED` below. For child tables with no tenancy
 *      column of their own.
 *   4. Only if none of the above fits, add a line to
 *      `ORG_CASCADE_FK_UNSAFE` -- and if its `reason` is anything other than
 *      `child-not-deleted`, the test requires a `note` explaining it.
 *
 * BURN-DOWN
 *
 * `ORG_CASCADE_FK_UNSAFE` is a debt ledger seeded from a live migrated
 * database on 2026-09-03 so the contract could land green. It is expected to
 * SHRINK. Entries come off it by fix-forward migration -- never by relaxing
 * the test. A stale entry (the FK was dropped, renamed, given an ON DELETE, or
 * its child table joined the cascade set) fails the burn-down test, so a
 * migration that fixes an edge forces the matching line out in the same PR.
 *
 * Three entries are NOT latent shapes but erasure failures that fire today for
 * any tenant with the relevant rows -- `restore_jobs`, `action_intents` and
 * `script_categories`, each carrying a note with its SQLSTATE and fix. They
 * are pinned rather than fixed because #4519 is explicitly scoped to making
 * the debt visible; the migrations are follow-up work.
 *
 * A `note` is not a fix. The two `partner_export_*` entries carry a reviewed
 * argument for why their edge is unreachable in practice, so they are not debt
 * in the ordinary sense -- but they stay pinned precisely because that
 * argument is transitive and nothing enforces it.
 *
 * Scope: the ORG cascade only. The device cascade
 * (`CORE_DEVICE_CASCADE_DELETE_TABLES`) and the partner purge have their own
 * contracts.
 */

/**
 * Why an edge is on the ledger. Recomputed from the catalog on every run and
 * checked against the stored value, so a `reason` cannot rot into a lie.
 */
export type OrgCascadeFkReason =
  /**
   * Ordinary debt, and the bulk of the ledger. No `ON DELETE` action, and
   * nothing in the erasure path empties the referencing table -- it has no
   * `org_id`, no cascade-list entry, and no pre-clear.
   */
  | 'child-not-deleted'
  /**
   * Both ends are emptied, in the wrong order: the parent goes first. Either
   * the parent is a step-1b pre-clear target while the child waits for the
   * cascade walk, or both are pre-cleared and the child sorts later in
   * `ASSOCIATED_SYSTEM_SCOPED_TABLES`.
   */
  | 'child-deleted-after-parent'
  /**
   * `ON DELETE SET NULL` over a column Postgres cannot null. Postgres accepts
   * such a constraint at DDL time and only fails when the delete runs -- with
   * 23502, not the 23503 everything else in this file produces.
   */
  | 'set-null-onto-not-null'
  /**
   * A self-referential edge whose deleted row set is not closed under it. The
   * end-of-statement exemption self-references normally get requires that
   * every row referencing a deleted row is deleted by the SAME statement;
   * a nullable `org_id` (partner-wide rows, epic #2135) breaks that, because
   * `WHERE org_id = $1` leaves the partner-owned rows behind.
   */
  | 'self-ref-open-row-set'
  /**
   * `ON DELETE SET DEFAULT`. Unused in this schema; safe only if the column
   * default happens to name a row that survives, which this contract does not
   * try to establish.
   */
  | 'set-default'
  /**
   * Not debt: the referencing table is emptied by an
   * `ASSOCIATED_SYSTEM_SCOPED_TABLES` pre-clear that runs before the parent's
   * DELETE. Only valid in `ORG_CASCADE_FK_PRE_CLEARED`.
   */
  | 'pre-cleared';

/** One FK edge, keyed the way `pg_constraint` keys it: (table, constraint name). */
export interface OrgCascadeFkRef {
  /** Referencing (child) table -- `pg_class` name of `pg_constraint.conrelid`. */
  childTable: string;
  /** `pg_constraint.conname`. Unique per table, not globally. */
  constraint: string;
  /** Referenced (parent) table. */
  parentTable: string;
  /** Recomputed and verified on every run; see `OrgCascadeFkReason`. */
  reason: OrgCascadeFkReason;
  /**
   * True when EVERY referencing column is nullable, i.e. a plain
   * `ON DELETE SET NULL` is a valid fix for this edge. Verified against the
   * catalog rather than trusted, because it is the triage signal that decides
   * whether the cheap fix is even available: `false` means the edge needs
   * `CASCADE`, a pre-clear, or a column-list `SET NULL`.
   */
  allColumnsNullable: boolean;
  /**
   * Why this entry is here beyond its `reason`. Required for every reason
   * except `child-not-deleted` and `pre-cleared`, whose shapes speak for
   * themselves.
   */
  note?: string;
}

/**
 * Edges the erasure path does not handle. Debt. Expected to shrink.
 *
 * Sorted by (parentTable, childTable, constraint) -- keep it that way; the
 * contract test enforces the order so diffs stay reviewable.
 */
export const ORG_CASCADE_FK_UNSAFE: ReadonlyArray<OrgCascadeFkRef> = Object.freeze([
  { childTable: 'ai_messages', constraint: 'ai_messages_session_id_ai_sessions_id_fk', parentTable: 'ai_sessions', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'ai_tool_executions', constraint: 'ai_tool_executions_session_id_ai_sessions_id_fk', parentTable: 'ai_sessions', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'alert_correlations', constraint: 'alert_correlations_child_alert_id_alerts_id_fk', parentTable: 'alerts', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'alert_correlations', constraint: 'alert_correlations_parent_alert_id_alerts_id_fk', parentTable: 'alerts', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'alert_notifications', constraint: 'alert_notifications_alert_id_alerts_id_fk', parentTable: 'alerts', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'dashboard_widgets', constraint: 'dashboard_widgets_dashboard_id_analytics_dashboards_id_fk', parentTable: 'analytics_dashboards', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'automation_policy_compliance', constraint: 'automation_policy_compliance_policy_id_automation_policies_id_f', parentTable: 'automation_policies', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'automation_runs', constraint: 'automation_runs_automation_id_automations_id_fk', parentTable: 'automations', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'deployment_devices', constraint: 'deployment_devices_deployment_id_deployments_id_fk', parentTable: 'deployments', reason: 'child-not-deleted', allColumnsNullable: false },
  {
    childTable: 'restore_jobs',
    constraint: 'restore_jobs_command_id_fkey',
    parentTable: 'device_commands',
    reason: 'child-deleted-after-parent',
    allColumnsNullable: true,
    note:
      'LIVE ERASURE FAILURE, not a latent shape. device_commands is emptied in step 1b, BEFORE the '
      + 'cascade walk that empties restore_jobs -- so any org that has ever run a restore driven by a '
      + 'device command aborts erasure at step 1b with 23503. Fix forward with ON DELETE SET NULL on '
      + 'command_id (it is nullable), or move the restore_jobs clear into '
      + 'ASSOCIATED_SYSTEM_SCOPED_TABLES ahead of device_commands.',
  },
  { childTable: 'automation_policy_compliance', constraint: 'automation_policy_compliance_device_id_devices_id_fk', parentTable: 'devices', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'deployment_devices', constraint: 'deployment_devices_device_id_devices_id_fk', parentTable: 'devices', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'device_software', constraint: 'device_software_device_id_devices_id_fk', parentTable: 'devices', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'patch_job_results', constraint: 'patch_job_results_device_id_devices_id_fk', parentTable: 'devices', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'patch_rollbacks', constraint: 'patch_rollbacks_device_id_devices_id_fk', parentTable: 'devices', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'software_compliance_status', constraint: 'software_compliance_status_device_id_devices_id_fk', parentTable: 'devices', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'maintenance_occurrences', constraint: 'maintenance_occurrences_window_id_maintenance_windows_id_fk', parentTable: 'maintenance_windows', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'alert_notifications', constraint: 'alert_notifications_channel_id_notification_channels_id_fk', parentTable: 'notification_channels', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'approval_requests', constraint: 'approval_requests_requesting_session_id_fkey', parentTable: 'oauth_sessions', reason: 'child-not-deleted', allColumnsNullable: true },
  {
    childTable: 'partner_export_device_material_state',
    constraint: 'partner_export_device_material_state_org_id_fkey',
    parentTable: 'organizations',
    reason: 'child-not-deleted',
    allColumnsNullable: false,
    note:
      'Reviewed, not plain debt. The table is deliberately outside the cascade list (its rows are '
      + 'written only by SECURITY DEFINER triggers, so breeze_app cannot DELETE them at all). Erasure '
      + 'reaches them through device_id, which IS ON DELETE CASCADE, and devices is emptied long '
      + 'before organizations. Pinned anyway because that argument is transitive: it would stop '
      + 'holding, silently, if the device_id edge ever changed.',
  },
  {
    childTable: 'partner_export_site_material_state',
    constraint: 'partner_export_site_material_state_org_id_fkey',
    parentTable: 'organizations',
    reason: 'child-not-deleted',
    allColumnsNullable: false,
    note:
      'Reviewed, not plain debt. Same shape as partner_export_device_material_state above, reached '
      + 'through its ON DELETE CASCADE site_id edge instead.',
  },
  { childTable: 'patch_job_results', constraint: 'patch_job_results_job_id_patch_jobs_id_fk', parentTable: 'patch_jobs', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'patch_rollbacks', constraint: 'patch_rollbacks_original_job_id_patch_jobs_id_fk', parentTable: 'patch_jobs', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'plugin_logs', constraint: 'plugin_logs_installation_id_plugin_installations_id_fk', parentTable: 'plugin_installations', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'ticket_comments', constraint: 'ticket_comments_portal_user_id_portal_users_id_fk', parentTable: 'portal_users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'auth_browser_transitions', constraint: 'auth_browser_transitions_current_family_owner_fk', parentTable: 'refresh_token_families', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'sso_token_exchange_grants', constraint: 'sso_token_exchange_grants_family_owner_fk', parentTable: 'refresh_token_families', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'access_review_items', constraint: 'access_review_items_role_id_roles_id_fk', parentTable: 'roles', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'partner_users', constraint: 'partner_users_role_id_roles_id_fk', parentTable: 'roles', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'role_permissions', constraint: 'role_permissions_role_id_roles_id_fk', parentTable: 'roles', reason: 'child-not-deleted', allColumnsNullable: false },
  {
    childTable: 'script_categories',
    constraint: 'script_categories_parent_id_script_categories_id_fk',
    parentTable: 'script_categories',
    reason: 'self-ref-open-row-set',
    allColumnsNullable: true,
    note:
      'LIVE ERASURE FAILURE. script_categories.org_id is NULLABLE (partner-wide categories, epic '
      + '#2135), so DELETE ... WHERE org_id = $1 does NOT remove a row set closed under this '
      + 'self-reference: a surviving partner-wide category whose parent_id points at an org-owned one '
      + 'raises 23503. Verified empirically against Postgres 16. Fix forward with ON DELETE SET NULL '
      + 'on parent_id.',
  },
  { childTable: 'script_to_tags', constraint: 'script_to_tags_tag_id_script_tags_id_fk', parentTable: 'script_tags', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'config_policy_compliance_rules', constraint: 'config_policy_compliance_rules_remediation_script_id_scripts_id', parentTable: 'scripts', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'patch_policies', constraint: 'patch_policies_post_install_script_id_scripts_id_fk', parentTable: 'scripts', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'patch_policies', constraint: 'patch_policies_pre_install_script_id_scripts_id_fk', parentTable: 'scripts', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'script_to_tags', constraint: 'script_to_tags_script_id_scripts_id_fk', parentTable: 'scripts', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'script_versions', constraint: 'script_versions_script_id_scripts_id_fk', parentTable: 'scripts', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'snmp_alert_thresholds', constraint: 'snmp_alert_thresholds_device_id_snmp_devices_id_fk', parentTable: 'snmp_devices', reason: 'child-not-deleted', allColumnsNullable: false },
  {
    childTable: 'action_intents',
    constraint: 'action_intents_scope_ticket_org_fk',
    parentTable: 'tickets',
    reason: 'set-null-onto-not-null',
    allColumnsNullable: false,
    note:
      'LIVE ERASURE FAILURE, and it fails with 23502 rather than 23503. The FK is ON DELETE SET '
      + 'NULL over (scope_ticket_id, org_id) with no confdelsetcols, and action_intents.org_id is NOT '
      + 'NULL -- so deleting a ticket tries to null a NOT NULL column. Fix forward by restricting the '
      + 'action to SET NULL (scope_ticket_id).',
  },
  { childTable: 'ticket_comments', constraint: 'ticket_comments_ticket_id_tickets_id_fk', parentTable: 'tickets', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'access_review_items', constraint: 'access_review_items_reviewed_by_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'access_review_items', constraint: 'access_review_items_user_id_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'accounting_connections', constraint: 'accounting_connections_connected_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'ai_tool_executions', constraint: 'ai_tool_executions_approved_by_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'authenticator_policies', constraint: 'authenticator_policies_updated_by_user_id_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'catalog_items', constraint: 'catalog_items_created_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'config_policy_assignments', constraint: 'config_policy_assignments_assigned_by_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'mobile_devices', constraint: 'mobile_devices_user_id_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'mobile_sessions', constraint: 'mobile_sessions_user_id_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'network_known_guests', constraint: 'network_known_guests_added_by_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'office_addin_user_bindings', constraint: 'office_addin_bindings_user_partner_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'office_addin_user_bindings', constraint: 'office_addin_user_bindings_revoked_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'office_addin_user_bindings', constraint: 'office_addin_user_bindings_user_id_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'partner_service_principal_keys', constraint: 'partner_service_principal_keys_created_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'partner_service_principals', constraint: 'partner_service_principals_created_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'partner_service_principals', constraint: 'partner_service_principals_updated_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'partner_users', constraint: 'partner_users_user_id_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'patch_approvals', constraint: 'patch_approvals_approved_by_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'patch_policies', constraint: 'patch_policies_created_by_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'patch_rollbacks', constraint: 'patch_rollbacks_initiated_by_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'pax8_integrations', constraint: 'pax8_integrations_created_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'push_notifications', constraint: 'push_notifications_user_id_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'script_versions', constraint: 'script_versions_created_by_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'sessions', constraint: 'sessions_user_id_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: false },
  { childTable: 'stripe_connect_accounts', constraint: 'stripe_connect_accounts_connected_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'td_synnex_digital_bridge_integrations', constraint: 'td_synnex_digital_bridge_integrations_created_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'td_synnex_ec_express_integrations', constraint: 'td_synnex_ec_express_integrations_created_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'td_synnex_sftp_integrations', constraint: 'td_synnex_sftp_integrations_created_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'ticket_comments', constraint: 'ticket_comments_user_id_users_id_fk', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'ticket_mailbox_connections', constraint: 'ticket_mailbox_connections_created_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'ticket_mailbox_consent_sessions', constraint: 'ticket_mailbox_consent_sessions_user_id_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'ticket_mailbox_tenant_ownerships', constraint: 'ticket_mailbox_tenant_ownerships_verified_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'ticket_response_templates', constraint: 'ticket_response_templates_created_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
  { childTable: 'unifi_integrations', constraint: 'unifi_integrations_created_by_fkey', parentTable: 'users', reason: 'child-not-deleted', allColumnsNullable: true },
]);

/**
 * Edges with no self-clearing `ON DELETE` whose referencing table IS emptied
 * first by an `ASSOCIATED_SYSTEM_SCOPED_TABLES` pre-clear. Handled, not debt.
 *
 * Pinned one-by-one rather than waved through per table, because the pre-clear
 * is hand-written SQL with its own WHERE join: `psa_ticket_mappings` needs
 * three separate arms to cover its three FKs, and a FOURTH FK on that table
 * would be silently uncovered if table membership alone satisfied the
 * contract. Listing every FK means a new one reds this test and sends the
 * author to read `clearSql`.
 *
 * What membership here does and does not assert: the test verifies the table
 * has a pre-clear and that the pre-clear runs before this parent's DELETE. It
 * cannot read the `clearSql` and confirm the join actually reaches the rows
 * this particular FK pins -- two entries below carry a note where the arm
 * demonstrably keys off a different column than the FK.
 *
 * Sorted by (parentTable, childTable, constraint), same as above.
 */
export const ORG_CASCADE_FK_PRE_CLEARED: ReadonlyArray<OrgCascadeFkRef> = Object.freeze([
  { childTable: 'psa_ticket_mappings', constraint: 'psa_ticket_mappings_alert_id_alerts_id_fk', parentTable: 'alerts', reason: 'pre-cleared', allColumnsNullable: true },
  {
    childTable: 'deployment_results',
    constraint: 'deployment_results_device_id_devices_id_fk',
    parentTable: 'devices',
    reason: 'pre-cleared',
    allColumnsNullable: false,
    note:
      'The deployment_results pre-clear keys off deployment_id only. A row pairing THIS org\'s '
      + 'device with another org\'s deployment would survive it and then pin `devices`. Cross-org '
      + 'pairing should be impossible, but nothing here proves it.',
  },
  { childTable: 'device_commands', constraint: 'device_commands_device_id_devices_id_fk', parentTable: 'devices', reason: 'pre-cleared', allColumnsNullable: false },
  { childTable: 'psa_ticket_mappings', constraint: 'psa_ticket_mappings_device_id_devices_id_fk', parentTable: 'devices', reason: 'pre-cleared', allColumnsNullable: true },
  { childTable: 'software_deployments', constraint: 'software_deployments_maintenance_window_id_maintenance_windows_', parentTable: 'maintenance_windows', reason: 'pre-cleared', allColumnsNullable: true },
  { childTable: 'software_deployments', constraint: 'software_deployments_org_id_organizations_id_fk', parentTable: 'organizations', reason: 'pre-cleared', allColumnsNullable: false },
  { childTable: 'psa_ticket_mappings', constraint: 'psa_ticket_mappings_connection_id_psa_connections_id_fk', parentTable: 'psa_connections', reason: 'pre-cleared', allColumnsNullable: false },
  { childTable: 'report_runs', constraint: 'report_runs_report_id_reports_id_fk', parentTable: 'reports', reason: 'pre-cleared', allColumnsNullable: false },
  { childTable: 'software_versions', constraint: 'software_versions_catalog_id_software_catalog_id_fk', parentTable: 'software_catalog', reason: 'pre-cleared', allColumnsNullable: false },
  { childTable: 'deployment_results', constraint: 'deployment_results_deployment_id_software_deployments_id_fk', parentTable: 'software_deployments', reason: 'pre-cleared', allColumnsNullable: false },
  { childTable: 'software_deployments', constraint: 'software_deployments_install_method_id_fkey', parentTable: 'software_install_methods', reason: 'pre-cleared', allColumnsNullable: true },
  { childTable: 'software_deployments', constraint: 'software_deployments_software_version_id_software_versions_id_f', parentTable: 'software_versions', reason: 'pre-cleared', allColumnsNullable: true },
  { childTable: 'sso_sessions', constraint: 'sso_sessions_provider_id_sso_providers_id_fk', parentTable: 'sso_providers', reason: 'pre-cleared', allColumnsNullable: false },
  { childTable: 'user_sso_identities', constraint: 'user_sso_identities_provider_id_sso_providers_id_fk', parentTable: 'sso_providers', reason: 'pre-cleared', allColumnsNullable: false },
  {
    childTable: 'device_commands',
    constraint: 'device_commands_created_by_users_id_fk',
    parentTable: 'users',
    reason: 'pre-cleared',
    allColumnsNullable: true,
    note:
      'The device_commands pre-clear keys off device_id only, so a command a user of THIS org '
      + 'queued against ANOTHER org\'s device would survive it and then pin `users`. Cross-org queuing '
      + 'should be impossible, but nothing here proves it.',
  },
  { childTable: 'software_deployments', constraint: 'software_deployments_created_by_users_id_fk', parentTable: 'users', reason: 'pre-cleared', allColumnsNullable: true },
  { childTable: 'user_sso_identities', constraint: 'user_sso_identities_user_id_users_id_fk', parentTable: 'users', reason: 'pre-cleared', allColumnsNullable: false },
]);
