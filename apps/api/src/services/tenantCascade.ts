/**
 * Tenant Cascade Service (Task 30 — GDPR org-wide erasure)
 *
 * Provides the authoritative list of `org_id`-scoped public tables, plus
 * a `cascadeDeleteOrg(orgId, performedBy)` helper that walks every such
 * table and removes the org's rows in FK-safe order.
 *
 * The list is authoritative. A contract test
 * (`__tests__/integration/tenantCascade.integration.test.ts`) cross-
 * checks `ORG_CASCADE_DELETE_ORDER` against `information_schema.columns`
 * and the documented `INTENTIONAL_UNSCOPED` allowlist mirror — a new
 * `org_id`-columned table that isn't in the cascade list will fail CI.
 *
 * FK-safe deletion strategy:
 *   We do NOT trust a hand-maintained topo order; FKs change.
 *   Instead, at delete time we query `pg_constraint` for the FK graph
 *   amongst the listed tables and topologically sort children-first.
 *   Tables outside the org-cascade set that hold FK references *into*
 *   the set (rare; e.g. `device_commands`) are handled by their own
 *   explicit pre-clear step in the same transaction.
 *
 * Auth/RLS:
 *   Cascade runs under `withSystemDbAccessContext`. The caller is
 *   already gated by platformAdmin + MFA at the route layer; the
 *   service does not re-check authorization — but it DOES require
 *   an explicit `performedBy` user id for the audit trail.
 *
 * audit_logs special-casing:
 *   - `audit_logs` is in the cascade list (it has an `org_id` column).
 *   - `breeze_app` cannot DELETE from `audit_logs` (Task 29 trigger);
 *     the cascade runs `SET LOCAL ROLE breeze_audit_admin` +
 *     `SET LOCAL breeze.allow_audit_retention = '1'` for that one table.
 *   - The `tenant.erasure` audit event itself is written with
 *     `org_id = NULL` BEFORE the cascade so it survives the cascade.
 *
 * The cascade is destructive and unrecoverable beyond Postgres PITR.
 */

import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { createAuditLog } from './auditService';
// Self-import so cascadeDeletePartner calls cascadeDeleteOrg /
// topologicalCascadeOrder through the module namespace. This keeps those
// internal calls interceptable by `vi.spyOn(mod, ...)` (an ESM live-binding
// reference, which bare in-module calls bypass).
import * as self from './tenantCascade';

/**
 * Authoritative list of `org_id`-scoped public tables that participate
 * in the GDPR cascade. Order is alphabetical for determinism — the
 * actual DELETE order is computed at runtime from the FK graph.
 *
 * Discovery query used to generate this list:
 *   SELECT DISTINCT table_name
 *   FROM information_schema.columns
 *   WHERE table_schema = 'public' AND column_name = 'org_id'
 *
 * Plus `organizations` itself (id-keyed, no `org_id` column).
 *
 * The contract test (`tenantCascade.integration.test.ts`) verifies this
 * list is the complete set — any new `org_id` table breaks CI.
 */
export const ORG_CASCADE_DELETE_ORDER: ReadonlyArray<string> = Object.freeze([
  'access_reviews',
  'account_deletion_requests',
  'agent_logs',
  'ai_action_plans',
  'ai_budgets',
  'ai_cost_usage',
  'ai_screenshots',
  'ai_sessions',
  'alert_correlation_groups',
  'alert_correlation_members',
  'alert_rules',
  'alert_templates',
  'alerts',
  'analytics_dashboards',
  'api_keys',
  'asset_checkouts',
  'audit_baseline_apply_approvals',
  'audit_baseline_results',
  'audit_baselines',
  'audit_chain_anchors',
  'audit_log_chain',
  'audit_logs',
  'audit_policy_states',
  'audit_retention_policies',
  'automation_policies',
  'automations',
  'backup_chains',
  'backup_configs',
  'backup_jobs',
  'backup_policies',
  'backup_sla_configs',
  'backup_sla_events',
  'backup_snapshots',
  'backup_verifications',
  'brain_device_context',
  'browser_extensions',
  'browser_policies',
  'browser_policy_violations',
  'c2c_backup_configs',
  'c2c_backup_items',
  'c2c_backup_jobs',
  'c2c_connections',
  'c2c_consent_sessions',
  'capacity_predictions',
  'capacity_thresholds',
  'catalog_item_org_pricing',
  'cis_baseline_results',
  'cis_baselines',
  'cis_remediation_actions',
  'client_ai_org_policies',
  'client_ai_prompt_templates',
  'client_ai_tenant_mappings',
  'client_ai_usage',
  'config_policy_backup_settings',
  'config_policy_onedrive_libraries',
  'config_policy_onedrive_settings',
  'configuration_policies',
  'contract_billing_periods',
  'contract_lines',
  'contract_renewal_notices',
  'contracts',
  'custom_field_definitions',
  // NB: sorts AFTER custom_field_definitions — localeCompare puts the '_' in
  // 'custom_field' before the 'e' in 'customer' (the prefix-extension trap).
  'customer_email_domains',
  'delegant_m365_connections',
  'deployment_invites',
  'deployments',
  'device_boot_metrics',
  'device_change_log',
  'device_config_state',
  'device_connections',
  'device_disks',
  'device_event_logs',
  'device_filesystem_cleanup_runs',
  'device_filesystem_scan_state',
  'device_filesystem_snapshots',
  'device_group_memberships',
  'device_groups',
  'device_hardware',
  'device_ip_history',
  'device_metrics',
  'device_network',
  'device_patches',
  'device_process_samples',
  'device_registry_state',
  'device_reliability',
  'device_reliability_history',
  'device_sessions',
  'device_vulnerabilities',
  'device_warranty',
  'devices',
  'discovered_assets',
  'discovery_jobs',
  'discovery_profiles',
  'dns_event_aggregations',
  'dns_filter_integrations',
  'dns_policies',
  'dns_security_events',
  'dr_executions',
  'dr_plan_groups',
  'dr_plans',
  'elevation_audit',
  'elevation_requests',
  'enrollment_keys',
  'escalation_policies',
  'event_bus_events',
  'executive_summaries',
  'google_workspace_connections',
  'group_membership_log',
  'huntress_agents',
  'huntress_incidents',
  'huntress_integrations',
  'huntress_org_mappings',
  'hyperv_vms',
  'incident_actions',
  'incident_evidence',
  'incidents',
  'installer_bootstrap_tokens',
  'invoice_documents',
  'invoice_lines',
  'invoice_payments',
  'invoice_stripe_payments',
  'invoices',
  'local_vaults',
  'log_correlation_rules',
  'log_correlations',
  'log_search_queries',
  'm365_connections',
  'maintenance_windows',
  'metric_anomalies',
  'metric_anomaly_candidates',
  'metric_rollups',
  'metric_rollups_default',
  'ml_feedback_events',
  'network_baselines',
  'network_change_events',
  'network_monitors',
  'network_topology',
  'notification_channels',
  'notification_routing_rules',
  'oauth_authorization_codes',
  'oauth_client_blocks',
  'oauth_grants',
  'oauth_refresh_tokens',
  'onedrive_device_state',
  'org_ticket_settings',
  'organization_users',
  'pam_org_config',
  'pam_rules',
  'pam_signer_groups',
  'patch_compliance_reports',
  'patch_compliance_snapshots',
  'patch_jobs',
  'pax8_company_mappings',
  'pax8_contract_line_links',
  'pax8_subscription_snapshots',
  'peripheral_events',
  'peripheral_policies',
  'playbook_definitions',
  'playbook_executions',
  'plugin_installations',
  'plugin_instances',
  'plugins',
  'portal_branding',
  'portal_users',
  'provision_credential_handles',
  'psa_connections',
  'quote_acceptances',
  'quote_blocks',
  'quote_images',
  'quote_lines',
  'quotes',
  'recovery_boot_media_artifacts',
  'recovery_media_artifacts',
  'recovery_readiness',
  'recovery_tokens',
  'remediation_suggestions',
  'remote_sessions',
  'reports',
  'restore_jobs',
  'roles',
  's1_actions',
  's1_agents',
  's1_integrations',
  's1_org_mappings',
  // s1_site_mappings is the legacy org-keyed mapping table retained as a
  // forensic record post-migration (see 2026-06-27-a-sentinelone-partner-mapping.sql).
  // It still carries org_id, so it must remain in the cascade list until dropped.
  's1_site_mappings',
  's1_threats',
  'saved_filters',
  'saved_queries',
  'script_categories',
  'script_execution_batches',
  'script_executions',
  'script_tags',
  'scripts',
  'security_policies',
  'security_posture_org_snapshots',
  'security_posture_snapshots',
  'security_scans',
  'security_status',
  'security_threats',
  'sensitive_data_findings',
  'sensitive_data_policies',
  'sensitive_data_scans',
  'service_process_check_results',
  'sites',
  'sla_compliance',
  'sla_definitions',
  'snmp_devices',
  'snmp_metrics',
  'snmp_templates',
  'software_catalog',
  'software_deployments',
  'software_inventory',
  'software_policies',
  'software_policy_audit',
  'sql_instances',
  'sso_providers',
  'sso_verified_domains',
  'storage_encryption_keys',
  'ticket_alert_links',
  'ticket_parts',
  'tickets',
  'time_entries',
  'time_series_metrics',
  'topology_layout',
  'topology_manual_nodes',
  'tunnel_allowlists',
  'tunnel_sessions',
  'user_notifications',
  'user_risk_events',
  'user_risk_policies',
  'user_risk_scores',
  'users',
  'vault_snapshot_inventory',
  'webhooks',
  // organizations is id-keyed (no org_id column). Cleared last.
  'organizations',
]);

/**
 * Tables that hold FK references INTO the cascade set but are themselves
 * system-scoped (no org_id) — they need targeted pre-clearing so cascade
 * deletes don't violate FK constraints.
 *
 * `device_commands.device_id → devices.id`: agent WS path; system-scoped
 * by design. We clear by joining through devices.
 */
const ASSOCIATED_SYSTEM_SCOPED_TABLES: ReadonlyArray<{
  table: string;
  clearSql: (orgId: string) => ReturnType<typeof sql>;
}> = [
  {
    table: 'device_commands',
    clearSql: (orgId) => sql`
      DELETE FROM device_commands
      WHERE device_id IN (SELECT id FROM devices WHERE org_id = ${orgId})
    `,
  },
];

/**
 * Tables in the cascade set that require the `breeze_audit_admin` role
 * to DELETE. These are gated by append-only triggers plus per-role DELETE
 * grants so ordinary app paths can append/read but cannot mutate them.
 */
const AUDIT_ADMIN_REQUIRED_TABLES: ReadonlySet<string> = new Set<string>([
  'audit_logs',
  'audit_log_chain',
  'audit_chain_anchors',
  'ml_feedback_events',
]);

interface FkEdge {
  // SQL aliases are snake_case (postgres-js does not auto-camelCase).
  child_table: string;
  parent_table: string;
}

/**
 * Read foreign-key edges from pg_catalog and return a topological order
 * of `ORG_CASCADE_DELETE_ORDER` where children come before parents.
 *
 * Tables not in `ORG_CASCADE_DELETE_ORDER` are ignored — they're either
 * out-of-scope or handled by `ASSOCIATED_SYSTEM_SCOPED_TABLES`.
 *
 * Self-referential FKs (e.g. devices.parent_id → devices.id) are
 * ignored: deleting the table in one statement handles them under the
 * single org's row set.
 *
 * Cycles between distinct tables would be detected here; we throw a
 * loud error so the deploy fails rather than silently producing a
 * partial cascade.
 */
export async function topologicalCascadeOrder(
  tables: Iterable<string> = ORG_CASCADE_DELETE_ORDER,
): Promise<string[]> {
  const tableSet = new Set(tables);
  const edges = (await dbModule.db.execute(sql`
    SELECT
      tc.relname AS child_table,
      tp.relname AS parent_table
    FROM pg_constraint c
    JOIN pg_class tc ON tc.oid = c.conrelid
    JOIN pg_class tp ON tp.oid = c.confrelid
    JOIN pg_namespace nc ON nc.oid = tc.relnamespace
    JOIN pg_namespace np ON np.oid = tp.relnamespace
    WHERE c.contype = 'f'
      AND nc.nspname = 'public'
      AND np.nspname = 'public'
      AND tc.relname <> tp.relname;
  `)) as unknown as FkEdge[];

  // Build dependency graph: deletion of `parent` requires `child` already
  // gone, so children are visited first in DFS post-order.
  const childToParents = new Map<string, Set<string>>();
  for (const table of tableSet) {
    childToParents.set(table, new Set());
  }
  for (const edge of edges) {
    if (!tableSet.has(edge.child_table) || !tableSet.has(edge.parent_table)) continue;
    childToParents.get(edge.child_table)!.add(edge.parent_table);
  }

  // Topological sort: produce an order where each table appears BEFORE
  // every table it depends on. We use DFS post-order on the inverse
  // graph (children → parents).
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: string[] = [];

  function visit(table: string, stack: string[]): void {
    if (visited.has(table)) return;
    if (visiting.has(table)) {
      throw new Error(
        `[tenantCascade] FK cycle detected involving ${table} (path: ${stack.join(' → ')} → ${table})`,
      );
    }
    visiting.add(table);
    // Visit every table that depends on this one first (so they get
    // deleted before us). We invert the edge direction here: for
    // each (child→parent) edge, when we reach `parent` we recurse to
    // its children.
    //
    // Implementation: precompute parentToChildren once for efficiency.
    const dependants = parentToChildren.get(table) ?? new Set();
    for (const dep of dependants) {
      visit(dep, [...stack, table]);
    }
    visiting.delete(table);
    visited.add(table);
    ordered.push(table);
  }

  const parentToChildren = new Map<string, Set<string>>();
  for (const table of tableSet) parentToChildren.set(table, new Set());
  for (const [child, parents] of childToParents) {
    for (const parent of parents) {
      parentToChildren.get(parent)!.add(child);
    }
  }

  // Iterate alphabetically for deterministic output across runs.
  const startingPoints = [...tableSet].sort();
  for (const table of startingPoints) {
    visit(table, []);
  }

  return ordered;
}

export interface CascadeStats {
  orgId: string;
  performedBy: string;
  startedAt: string;
  durationMs: number;
  tablesDeleted: Record<string, number>;
  totalRowsDeleted: number;
}

/**
 * Hard-deletes every row keyed on this org across the cascade set.
 *
 * `performedBy` is the platform-admin user id; embedded in the
 * `tenant.erasure` audit event written BEFORE the cascade runs (the
 * cascade itself will then drop the org's `audit_logs` rows; the
 * tenant.erasure event survives because it's written with org_id=NULL).
 *
 * Idempotent: re-running on an already-erased org matches zero rows.
 */
export async function cascadeDeleteOrg(
  orgId: string,
  performedBy: string,
  performedByEmail?: string,
): Promise<CascadeStats> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const stats: CascadeStats = {
    orgId,
    performedBy,
    startedAt,
    durationMs: 0,
    tablesDeleted: {},
    totalRowsDeleted: 0,
  };

  // Write the tenant.erasure audit row FIRST so it survives the cascade.
  // org_id=NULL → system-scope event, not subject to the org-axis delete
  // we're about to perform on audit_logs.
  await createAuditLog({
    orgId: null,
    actorType: 'user',
    actorId: performedBy,
    actorEmail: performedByEmail,
    action: 'tenant.erasure.started',
    resourceType: 'organization',
    resourceId: orgId,
    details: { startedAt },
    result: 'success',
  });

  // Compute the FK-safe order from the actual catalog. If a cycle is
  // detected we throw and abort BEFORE deleting anything.
  const order = await topologicalCascadeOrder();

  await dbModule.withSystemDbAccessContext(async () => {
    // 1. Clear system-scoped associated tables (e.g. device_commands)
    //    that hold FKs into the cascade set.
    for (const assoc of ASSOCIATED_SYSTEM_SCOPED_TABLES) {
      try {
        const result = await dbModule.db.execute(assoc.clearSql(orgId));
        const count = extractRowCount(result);
        stats.tablesDeleted[assoc.table] = (stats.tablesDeleted[assoc.table] ?? 0) + count;
        stats.totalRowsDeleted += count;
      } catch (err) {
        // Tolerate missing tables (e.g. a deployment that doesn't have
        // every optional table). Re-throw on anything else.
        if (!isUndefinedTable(err)) throw err;
      }
    }
  });

  // 2. Walk the cascade list in FK-safe order, each table in its OWN
  //    system-context transaction so a failure on one table aborts
  //    cleanly without poisoning the next statement.
  for (const table of order) {
    try {
      const count = await dbModule.withSystemDbAccessContext(async () => {
        const isAuditAdmin = AUDIT_ADMIN_REQUIRED_TABLES.has(table);
        if (isAuditAdmin) {
          // Two-layer bypass for audit_logs DELETE — same pattern as
          // auditRetention.ts. Both must be SET LOCAL so they revert
          // on commit/rollback automatically.
          await dbModule.db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
          await dbModule.db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
        }

        const result = await deleteOrgRows(table, orgId);
        return extractRowCount(result);
      });
      stats.tablesDeleted[table] = (stats.tablesDeleted[table] ?? 0) + count;
      stats.totalRowsDeleted += count;
    } catch (err) {
      // A single table failure aborts the cascade — partial deletion is
      // worse than no deletion (the org sits in an inconsistent state).
      // Re-throw with context.
      throw new Error(
        `[tenantCascade] DELETE from "${table}" failed for org=${orgId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  stats.durationMs = Date.now() - startedAtMs;

  // Write a completion audit event capturing per-table row counts.
  await createAuditLog({
    orgId: null,
    actorType: 'user',
    actorId: performedBy,
    actorEmail: performedByEmail,
    action: 'tenant.erasure.completed',
    resourceType: 'organization',
    resourceId: orgId,
    details: {
      startedAt,
      durationMs: stats.durationMs,
      totalRowsDeleted: stats.totalRowsDeleted,
      tablesDeleted: stats.tablesDeleted,
    },
    result: 'success',
  });

  return stats;
}

function deleteOrgRows(
  table: string,
  orgId: string,
): ReturnType<typeof dbModule.db.execute> {
  // `organizations` is id-keyed (its own primary key IS the org id);
  // every other table in the list has an `org_id` column.
  if (table === 'organizations') {
    return dbModule.db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`);
  }
  return dbModule.db.execute(
    sql`DELETE FROM ${sql.raw(quoteIdent(table))} WHERE org_id = ${orgId}`,
  );
}

function extractRowCount(result: unknown): number {
  const raw = result as { rowCount?: number; count?: number; length?: number };
  if (typeof raw?.rowCount === 'number') return raw.rowCount;
  if (typeof raw?.count === 'number') return raw.count;
  if (Array.isArray(result)) return (result as unknown[]).length;
  return 0;
}

function isUndefinedTable(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  // Postgres SQLSTATE 42P01 = undefined_table
  return code === '42P01';
}

/**
 * Quote an identifier safely. Only `[a-z0-9_]+` table names are
 * permitted (the cascade list is built from `information_schema`, but
 * defense in depth: reject anything else to keep `sql.raw` safe).
 */
function quoteIdent(table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`[tenantCascade] refusing to quote unsafe identifier: ${table}`);
  }
  return `"${table}"`;
}

export interface PartnerCascadeStats {
  orgsDeleted: number;
  tablesSwept: number;
  totalRowsDeleted: number;
  tablesDeleted: Record<string, number>;
}

/**
 * Hard-deletes a partner and ALL its data. Built for synthetic test-canary
 * cleanup (see routes/internal/synthetic.ts). The caller MUST have already
 * verified the partner is a disposable canary — this helper does not re-check.
 *
 * Strategy (mirrors cascadeDeleteOrg):
 *   1. For each child org -> cascadeDeleteOrg (also removes the organizations row).
 *   2. FK-safe sweep of every public table with a `partner_id` column, deleting
 *      this partner's rows children-first. One DELETE per call so a single FK
 *      failure cannot poison a shared transaction.
 *   3. Delete the partners row last.
 *
 * Returns the ACTUAL number of rows deleted per table (via `extractRowCount`),
 * not the count of tables attempted — so a purge that silently matched zero
 * rows (e.g. a future contextless-write regression under forced RLS, #1375)
 * is visible as `totalRowsDeleted === 0` rather than masquerading as success.
 *
 * Audit trail: a `purge_started` row is written BEFORE any delete (org_id=NULL,
 * so it survives the cascade); a `purged` completion row after. On a mid-sweep
 * failure a best-effort `purge_failed` row records how far the sweep got before
 * the error is rethrown — a destructive op must never abort without a forensic
 * record. Both the completion and failure audit writes are best-effort: the
 * partner is already (partly) deleted, so an audit hiccup must not change the
 * outcome the caller sees.
 *
 * Idempotent: re-running on an already-purged partner matches zero rows.
 */
export async function cascadeDeletePartner(
  partnerId: string,
  performedBy: string,
): Promise<PartnerCascadeStats> {
  const startedAt = new Date().toISOString();
  const tablesDeleted: Record<string, number> = {};
  let totalRowsDeleted = 0;

  // Forensic breadcrumb written first (org_id=NULL → survives the cascade).
  await createAuditLog({
    orgId: null,
    actorType: 'system',
    actorId: performedBy,
    action: 'test.synthetic_partner.purge_started',
    resourceType: 'partner',
    resourceId: partnerId,
    details: { partnerId, startedAt },
    result: 'success',
  });

  // Lookup child orgs under system context — organizations has partner-axis RLS;
  // bare breeze_app would silently return 0 rows.
  const orgRows = (await dbModule.withSystemDbAccessContext(() =>
    dbModule.db.execute(
      sql`SELECT id FROM organizations WHERE partner_id = ${partnerId}`,
    ),
  )) as unknown as Array<{ id: string }>;

  // cascadeDeleteOrg manages its own per-statement withSystemDbAccessContext calls;
  // do NOT wrap these calls in an outer context (would nest transactions).
  // NB: org_id-direct tables (e.g. topology_layout, #1728) are purged here too,
  // since cascadeDeleteOrg walks the full ORG_CASCADE_DELETE_ORDER per child org.
  for (const row of orgRows) {
    const orgStats = await self.cascadeDeleteOrg(row.id, performedBy);
    totalRowsDeleted += orgStats.totalRowsDeleted;
  }

  // information_schema is not RLS-protected — bare db.execute is fine here.
  const partnerTableRows = (await dbModule.db.execute(sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'partner_id'
      AND table_name <> 'organizations'
  `)) as unknown as Array<{ table_name: string }>;
  const partnerTables = partnerTableRows.map((r) => r.table_name);
  const order = await self.topologicalCascadeOrder(partnerTables);
  const orderedSet = new Set(order);
  const sweep = [...order, ...partnerTables.filter((t) => !orderedSet.has(t))];

  // Wrap each partner-axis DELETE individually under system context so they
  // don't silently match zero rows under breeze_app RLS (partner-axis tables
  // are RLS-protected and bare breeze_app cannot write them).
  for (const table of sweep) {
    try {
      const count = await dbModule.withSystemDbAccessContext(async () => {
        const result = await dbModule.db.execute(
          sql`DELETE FROM ${sql.raw(quoteIdent(table))} WHERE partner_id = ${partnerId}`,
        );
        return extractRowCount(result);
      });
      tablesDeleted[table] = (tablesDeleted[table] ?? 0) + count;
      totalRowsDeleted += count;
    } catch (err) {
      // Best-effort forensic record of partial progress before we abort. The
      // partner is now half-deleted; a re-run is idempotent and will finish.
      await writePurgeFailedAudit(performedBy, partnerId, table, tablesDeleted, err);
      throw new Error(
        `[tenantCascade] DELETE from "${table}" failed for partner=${partnerId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Final partners DELETE also needs system context.
  const partnerCount = await dbModule.withSystemDbAccessContext(async () => {
    const result = await dbModule.db.execute(sql`DELETE FROM partners WHERE id = ${partnerId}`);
    return extractRowCount(result);
  });
  tablesDeleted.partners = (tablesDeleted.partners ?? 0) + partnerCount;
  totalRowsDeleted += partnerCount;

  // Best-effort completion audit: the deletes have already landed, so an audit
  // persistence hiccup must not turn a successful purge into a 500.
  try {
    await createAuditLog({
      orgId: null,
      actorType: 'system',
      actorId: performedBy,
      action: 'test.synthetic_partner.purged',
      resourceType: 'partner',
      resourceId: partnerId,
      details: { partnerId, startedAt, orgsDeleted: orgRows.length, tablesSwept: sweep.length, totalRowsDeleted, tablesDeleted },
      result: 'success',
    });
  } catch (err) {
    console.warn('[tenantCascade] purge-completed audit write failed:', err);
  }

  return { orgsDeleted: orgRows.length, tablesSwept: sweep.length, totalRowsDeleted, tablesDeleted };
}

async function writePurgeFailedAudit(
  performedBy: string,
  partnerId: string,
  failedTable: string,
  tablesDeleted: Record<string, number>,
  err: unknown,
): Promise<void> {
  try {
    await createAuditLog({
      orgId: null,
      actorType: 'system',
      actorId: performedBy,
      action: 'test.synthetic_partner.purge_failed',
      resourceType: 'partner',
      resourceId: partnerId,
      details: {
        partnerId,
        failedTable,
        tablesDeleted,
        error: err instanceof Error ? err.message : String(err),
      },
      result: 'failure',
    });
  } catch (auditErr) {
    console.warn('[tenantCascade] purge-failed audit write failed:', auditErr);
  }
}

/**
 * Exposed for tests / introspection.
 */
export const __testOnly = {
  ASSOCIATED_SYSTEM_SCOPED_TABLES,
  AUDIT_ADMIN_REQUIRED_TABLES,
  quoteIdent,
  extractRowCount,
};
