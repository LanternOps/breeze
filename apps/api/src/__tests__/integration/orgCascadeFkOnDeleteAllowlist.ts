/**
 * Known-unsafe FK ledger for the GDPR org-erasure cascade (#4519).
 *
 * Enforced by `orgCascadeFkOnDelete.integration.test.ts`. Read that file's
 * header for the full safety argument; the short version:
 *
 *   `cascadeDeleteOrg()` empties every table in `getOrgCascadeDeleteOrder()`
 *   with a plain `DELETE ... WHERE org_id = $1`, children first. A foreign key
 *   POINTING AT one of those tables is only safe if Postgres clears it for us
 *   (`ON DELETE CASCADE` / `SET NULL`) or the referencing table is itself
 *   emptied first — by the cascade walk, or by an
 *   `ASSOCIATED_SYSTEM_SCOPED_TABLES` pre-clear. Anything else is a latent
 *   `23503 foreign_key_violation` that only fires once a customer actually
 *   creates a row in the child table (exactly how #4100 shipped).
 *
 * ── HOW TO USE THIS FILE ────────────────────────────────────────────────────
 *
 * You are here because the contract test failed. Do NOT reflexively add a line.
 * In order of preference:
 *
 *   1. Give the FK an explicit `ON DELETE` in a NEW, idempotent, fix-forward
 *      migration (never edit a shipped one). `CASCADE` when the child row is
 *      meaningless without the parent; `SET NULL` when it is an optional
 *      back-reference and the column is nullable. This is the answer for
 *      nearly every new FK.
 *   2. Register the child table in `CORE_ORG_CASCADE_DELETE_ORDER` — plus
 *      every other list CLAUDE.md's cascade-registration table demands
 *      (device cascade, export policy, ...). Only valid if the child has its
 *      own `org_id`.
 *   3. Add an `ASSOCIATED_SYSTEM_SCOPED_TABLES` pre-clear in
 *      `services/tenantCascade.ts`, then record the FK in
 *      `ORG_CASCADE_FK_PRE_CLEARED` below. For child tables with no tenancy
 *      column of their own.
 *   4. Only if none of the above fits, add a line to
 *      `ORG_CASCADE_FK_KNOWN_UNSAFE` with a `note` recording WHY.
 *
 * ── BURN-DOWN ───────────────────────────────────────────────────────────────
 *
 * `ORG_CASCADE_FK_KNOWN_UNSAFE` is a debt ledger seeded from a live database
 * on 2026-09-03 so the contract could land green (68 entries). It is expected
 * to SHRINK. Entries come off it by fix-forward migration — never by relaxing
 * the test. The test refuses a stale entry (one whose FK no longer exists, or
 * is no longer unsafe), so a migration that fixes an edge forces the matching
 * line to be deleted in the same PR and the ledger can never quietly overstate
 * the debt.
 *
 * A `note` is NOT a fix. Three entries below carry a reviewed argument about
 * the edge rather than plain debt; the two `partner_export_*` ones stay pinned
 * precisely because their safety argument is transitive and nothing enforces
 * it, and the `device_commands` one records a gap in an existing pre-clear.
 *
 * Scope: the ORG cascade only. The device cascade
 * (`CORE_DEVICE_CASCADE_DELETE_TABLES`) and the partner purge have their own
 * contracts.
 */

/** One FK edge, keyed the way `pg_constraint` keys it: (table, constraint name). */
export interface OrgCascadeFkRef {
  /** Referencing (child) table — `pg_class` name of `pg_constraint.conrelid`. */
  childTable: string;
  /** `pg_constraint.conname`. Unique per table, not globally. */
  constraint: string;
  /** Referenced (parent) table; always a member of `getOrgCascadeDeleteOrder()`. */
  parentTable: string;
  /**
   * True when EVERY referencing column is `NOT NULL`. Verified against the
   * catalog by the contract test, so it cannot rot. It is the triage signal
   * that matters: a NOT NULL edge cannot be fixed with `ON DELETE SET NULL`,
   * so it needs `CASCADE` (or a pre-clear) instead.
   */
  notNull: boolean;
  /** Why this edge is still here. Required for anything that is not plain debt. */
  note?: string;
}

/**
 * FKs into org-cascade tables that carry no `ON DELETE` action AND whose child
 * table is reached by neither the cascade walk nor a pre-clear.
 *
 * Sorted by (parentTable, childTable, constraint) — keep it that way; the
 * contract test enforces the order so diffs stay reviewable.
 */
export const ORG_CASCADE_FK_KNOWN_UNSAFE: ReadonlyArray<OrgCascadeFkRef> = Object.freeze([
  { childTable: 'ai_messages', constraint: 'ai_messages_session_id_ai_sessions_id_fk', parentTable: 'ai_sessions', notNull: true },
  { childTable: 'ai_tool_executions', constraint: 'ai_tool_executions_session_id_ai_sessions_id_fk', parentTable: 'ai_sessions', notNull: true },
  { childTable: 'alert_correlations', constraint: 'alert_correlations_child_alert_id_alerts_id_fk', parentTable: 'alerts', notNull: true },
  { childTable: 'alert_correlations', constraint: 'alert_correlations_parent_alert_id_alerts_id_fk', parentTable: 'alerts', notNull: true },
  { childTable: 'alert_notifications', constraint: 'alert_notifications_alert_id_alerts_id_fk', parentTable: 'alerts', notNull: true },
  { childTable: 'dashboard_widgets', constraint: 'dashboard_widgets_dashboard_id_analytics_dashboards_id_fk', parentTable: 'analytics_dashboards', notNull: true },
  { childTable: 'automation_policy_compliance', constraint: 'automation_policy_compliance_policy_id_automation_policies_id_f', parentTable: 'automation_policies', notNull: false },
  { childTable: 'automation_runs', constraint: 'automation_runs_automation_id_automations_id_fk', parentTable: 'automations', notNull: false },
  { childTable: 'deployment_devices', constraint: 'deployment_devices_deployment_id_deployments_id_fk', parentTable: 'deployments', notNull: true },
  { childTable: 'automation_policy_compliance', constraint: 'automation_policy_compliance_device_id_devices_id_fk', parentTable: 'devices', notNull: true },
  { childTable: 'deployment_devices', constraint: 'deployment_devices_device_id_devices_id_fk', parentTable: 'devices', notNull: true },
  { childTable: 'device_software', constraint: 'device_software_device_id_devices_id_fk', parentTable: 'devices', notNull: true },
  { childTable: 'patch_job_results', constraint: 'patch_job_results_device_id_devices_id_fk', parentTable: 'devices', notNull: true },
  { childTable: 'patch_rollbacks', constraint: 'patch_rollbacks_device_id_devices_id_fk', parentTable: 'devices', notNull: true },
  { childTable: 'software_compliance_status', constraint: 'software_compliance_status_device_id_devices_id_fk', parentTable: 'devices', notNull: true },
  { childTable: 'maintenance_occurrences', constraint: 'maintenance_occurrences_window_id_maintenance_windows_id_fk', parentTable: 'maintenance_windows', notNull: true },
  { childTable: 'alert_notifications', constraint: 'alert_notifications_channel_id_notification_channels_id_fk', parentTable: 'notification_channels', notNull: true },
  {
    childTable: 'partner_export_device_material_state',
    constraint: 'partner_export_device_material_state_org_id_fkey',
    parentTable: 'organizations',
    notNull: true,
    note:
      'Reviewed, not debt. The table is deliberately excluded from the cascade list (its rows '
      + 'are written only by SECURITY DEFINER triggers, so breeze_app cannot DELETE them at '
      + 'all). Erasure reaches them through device_id, which IS ON DELETE CASCADE, and devices '
      + 'is emptied long before organizations. Still pinned because that argument is '
      + 'transitive: it would silently stop holding if the device_id edge ever changed.',
  },
  {
    childTable: 'partner_export_site_material_state',
    constraint: 'partner_export_site_material_state_org_id_fkey',
    parentTable: 'organizations',
    notNull: true,
    note:
      'Reviewed, not debt. Same shape as partner_export_device_material_state above, reached '
      + 'through its ON DELETE CASCADE site_id edge instead.',
  },
  { childTable: 'patch_job_results', constraint: 'patch_job_results_job_id_patch_jobs_id_fk', parentTable: 'patch_jobs', notNull: true },
  { childTable: 'patch_rollbacks', constraint: 'patch_rollbacks_original_job_id_patch_jobs_id_fk', parentTable: 'patch_jobs', notNull: false },
  { childTable: 'plugin_logs', constraint: 'plugin_logs_installation_id_plugin_installations_id_fk', parentTable: 'plugin_installations', notNull: true },
  { childTable: 'ticket_comments', constraint: 'ticket_comments_portal_user_id_portal_users_id_fk', parentTable: 'portal_users', notNull: false },
  { childTable: 'access_review_items', constraint: 'access_review_items_role_id_roles_id_fk', parentTable: 'roles', notNull: true },
  { childTable: 'partner_users', constraint: 'partner_users_role_id_roles_id_fk', parentTable: 'roles', notNull: true },
  { childTable: 'role_permissions', constraint: 'role_permissions_role_id_roles_id_fk', parentTable: 'roles', notNull: true },
  { childTable: 'script_to_tags', constraint: 'script_to_tags_tag_id_script_tags_id_fk', parentTable: 'script_tags', notNull: true },
  { childTable: 'config_policy_compliance_rules', constraint: 'config_policy_compliance_rules_remediation_script_id_scripts_id', parentTable: 'scripts', notNull: false },
  { childTable: 'patch_policies', constraint: 'patch_policies_post_install_script_id_scripts_id_fk', parentTable: 'scripts', notNull: false },
  { childTable: 'patch_policies', constraint: 'patch_policies_pre_install_script_id_scripts_id_fk', parentTable: 'scripts', notNull: false },
  { childTable: 'script_to_tags', constraint: 'script_to_tags_script_id_scripts_id_fk', parentTable: 'scripts', notNull: true },
  { childTable: 'script_versions', constraint: 'script_versions_script_id_scripts_id_fk', parentTable: 'scripts', notNull: true },
  { childTable: 'snmp_alert_thresholds', constraint: 'snmp_alert_thresholds_device_id_snmp_devices_id_fk', parentTable: 'snmp_devices', notNull: true },
  { childTable: 'ticket_comments', constraint: 'ticket_comments_ticket_id_tickets_id_fk', parentTable: 'tickets', notNull: true },
  { childTable: 'access_review_items', constraint: 'access_review_items_reviewed_by_users_id_fk', parentTable: 'users', notNull: false },
  { childTable: 'access_review_items', constraint: 'access_review_items_user_id_users_id_fk', parentTable: 'users', notNull: true },
  { childTable: 'accounting_connections', constraint: 'accounting_connections_connected_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'ai_tool_executions', constraint: 'ai_tool_executions_approved_by_users_id_fk', parentTable: 'users', notNull: false },
  { childTable: 'authenticator_policies', constraint: 'authenticator_policies_updated_by_user_id_fkey', parentTable: 'users', notNull: false },
  { childTable: 'catalog_items', constraint: 'catalog_items_created_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'config_policy_assignments', constraint: 'config_policy_assignments_assigned_by_users_id_fk', parentTable: 'users', notNull: false },
  { childTable: 'mobile_devices', constraint: 'mobile_devices_user_id_users_id_fk', parentTable: 'users', notNull: true },
  { childTable: 'mobile_sessions', constraint: 'mobile_sessions_user_id_users_id_fk', parentTable: 'users', notNull: true },
  { childTable: 'network_known_guests', constraint: 'network_known_guests_added_by_users_id_fk', parentTable: 'users', notNull: false },
  { childTable: 'office_addin_user_bindings', constraint: 'office_addin_bindings_user_partner_fk', parentTable: 'users', notNull: true },
  { childTable: 'office_addin_user_bindings', constraint: 'office_addin_user_bindings_revoked_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'office_addin_user_bindings', constraint: 'office_addin_user_bindings_user_id_fkey', parentTable: 'users', notNull: true },
  { childTable: 'partner_service_principal_keys', constraint: 'partner_service_principal_keys_created_by_fkey', parentTable: 'users', notNull: true },
  { childTable: 'partner_service_principals', constraint: 'partner_service_principals_created_by_fkey', parentTable: 'users', notNull: true },
  { childTable: 'partner_service_principals', constraint: 'partner_service_principals_updated_by_fkey', parentTable: 'users', notNull: true },
  { childTable: 'partner_users', constraint: 'partner_users_user_id_users_id_fk', parentTable: 'users', notNull: true },
  { childTable: 'patch_approvals', constraint: 'patch_approvals_approved_by_users_id_fk', parentTable: 'users', notNull: false },
  { childTable: 'patch_policies', constraint: 'patch_policies_created_by_users_id_fk', parentTable: 'users', notNull: false },
  { childTable: 'patch_rollbacks', constraint: 'patch_rollbacks_initiated_by_users_id_fk', parentTable: 'users', notNull: false },
  { childTable: 'pax8_integrations', constraint: 'pax8_integrations_created_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'push_notifications', constraint: 'push_notifications_user_id_users_id_fk', parentTable: 'users', notNull: true },
  { childTable: 'script_versions', constraint: 'script_versions_created_by_users_id_fk', parentTable: 'users', notNull: false },
  { childTable: 'sessions', constraint: 'sessions_user_id_users_id_fk', parentTable: 'users', notNull: true },
  { childTable: 'stripe_connect_accounts', constraint: 'stripe_connect_accounts_connected_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'td_synnex_digital_bridge_integrations', constraint: 'td_synnex_digital_bridge_integrations_created_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'td_synnex_ec_express_integrations', constraint: 'td_synnex_ec_express_integrations_created_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'td_synnex_sftp_integrations', constraint: 'td_synnex_sftp_integrations_created_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'ticket_comments', constraint: 'ticket_comments_user_id_users_id_fk', parentTable: 'users', notNull: false },
  { childTable: 'ticket_mailbox_connections', constraint: 'ticket_mailbox_connections_created_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'ticket_mailbox_consent_sessions', constraint: 'ticket_mailbox_consent_sessions_user_id_fkey', parentTable: 'users', notNull: false },
  { childTable: 'ticket_mailbox_tenant_ownerships', constraint: 'ticket_mailbox_tenant_ownerships_verified_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'ticket_response_templates', constraint: 'ticket_response_templates_created_by_fkey', parentTable: 'users', notNull: false },
  { childTable: 'unifi_integrations', constraint: 'unifi_integrations_created_by_fkey', parentTable: 'users', notNull: false },
]);

/**
 * FKs into org-cascade tables with no `ON DELETE`, whose child table IS
 * emptied first by an `ASSOCIATED_SYSTEM_SCOPED_TABLES` pre-clear in
 * `services/tenantCascade.ts`. These are handled, not debt.
 *
 * They are still pinned one-by-one rather than waved through per table,
 * because the pre-clear is hand-written SQL: `psa_ticket_mappings` needs three
 * separate arms to cover its three FKs, and a FOURTH FK added to that table
 * would be silently uncovered if table membership alone satisfied the
 * contract. Adding an FK to a pre-clear table therefore reds this test and
 * forces the author to open `clearSql` and check it.
 *
 * Sorted by (parentTable, childTable, constraint), same as above.
 */
export const ORG_CASCADE_FK_PRE_CLEARED: ReadonlyArray<OrgCascadeFkRef> = Object.freeze([
  { childTable: 'psa_ticket_mappings', constraint: 'psa_ticket_mappings_alert_id_alerts_id_fk', parentTable: 'alerts', notNull: false },
  { childTable: 'deployment_results', constraint: 'deployment_results_device_id_devices_id_fk', parentTable: 'devices', notNull: true },
  { childTable: 'device_commands', constraint: 'device_commands_device_id_devices_id_fk', parentTable: 'devices', notNull: true },
  { childTable: 'psa_ticket_mappings', constraint: 'psa_ticket_mappings_device_id_devices_id_fk', parentTable: 'devices', notNull: false },
  { childTable: 'psa_ticket_mappings', constraint: 'psa_ticket_mappings_connection_id_psa_connections_id_fk', parentTable: 'psa_connections', notNull: true },
  { childTable: 'report_runs', constraint: 'report_runs_report_id_reports_id_fk', parentTable: 'reports', notNull: true },
  { childTable: 'software_versions', constraint: 'software_versions_catalog_id_software_catalog_id_fk', parentTable: 'software_catalog', notNull: true },
  { childTable: 'deployment_results', constraint: 'deployment_results_deployment_id_software_deployments_id_fk', parentTable: 'software_deployments', notNull: true },
  { childTable: 'sso_sessions', constraint: 'sso_sessions_provider_id_sso_providers_id_fk', parentTable: 'sso_providers', notNull: true },
  { childTable: 'user_sso_identities', constraint: 'user_sso_identities_provider_id_sso_providers_id_fk', parentTable: 'sso_providers', notNull: true },
  {
    childTable: 'device_commands',
    constraint: 'device_commands_created_by_users_id_fk',
    parentTable: 'users',
    notNull: false,
    note:
      'The device_commands pre-clear keys off device_id only, so a command a user of THIS org '
      + 'queued against ANOTHER org\'s device would survive the pre-clear and then pin `users`. '
      + 'Cross-org queuing should be impossible under RLS, but nothing here proves it.',
  },
  { childTable: 'user_sso_identities', constraint: 'user_sso_identities_user_id_users_id_fk', parentTable: 'users', notNull: true },
]);
