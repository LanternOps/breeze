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
  'alert_rules',
  'alert_templates',
  'alerts',
  'analytics_dashboards',
  'api_keys',
  'asset_checkouts',
  'audit_baseline_apply_approvals',
  'audit_baseline_results',
  'audit_baselines',
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
  'cis_baseline_results',
  'cis_baselines',
  'cis_remediation_actions',
  'config_policy_backup_settings',
  'configuration_policies',
  'custom_field_definitions',
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
  'device_registry_state',
  'device_reliability',
  'device_reliability_history',
  'device_sessions',
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
  'group_membership_log',
  'huntress_agents',
  'huntress_incidents',
  'huntress_integrations',
  'hyperv_vms',
  'incident_actions',
  'incident_evidence',
  'incidents',
  'installer_bootstrap_tokens',
  'local_vaults',
  'log_correlation_rules',
  'log_correlations',
  'log_search_queries',
  'maintenance_windows',
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
  'organization_users',
  'pam_rules',
  'patch_approvals',
  'patch_compliance_reports',
  'patch_compliance_snapshots',
  'patch_jobs',
  'patch_policies',
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
  'recovery_boot_media_artifacts',
  'recovery_media_artifacts',
  'recovery_readiness',
  'recovery_tokens',
  'remote_sessions',
  'reports',
  'restore_jobs',
  'roles',
  's1_actions',
  's1_agents',
  's1_integrations',
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
  'storage_encryption_keys',
  'ticket_alert_links',
  'tickets',
  'time_series_metrics',
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
 * to DELETE. These are gated by the audit_log_immutable trigger and
 * the per-role DELETE grant established in migration 2026-05-25-i.
 */
const AUDIT_ADMIN_REQUIRED_TABLES: ReadonlySet<string> = new Set<string>(['audit_logs']);

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
export async function topologicalCascadeOrder(): Promise<string[]> {
  const tableSet = new Set(ORG_CASCADE_DELETE_ORDER);
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

/**
 * Exposed for tests / introspection.
 */
export const __testOnly = {
  ASSOCIATED_SYSTEM_SCOPED_TABLES,
  AUDIT_ADMIN_REQUIRED_TABLES,
  quoteIdent,
  extractRowCount,
};
