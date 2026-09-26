import { sql, type SQL } from 'drizzle-orm';

type SqlExecutor = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/**
 * Deletes the topology policy alerts a site OWNS (M3-D6: alerts.topology_site_id,
 * FK `alerts_topology_site_fk` → sites, NO ACTION) and every alert child whose
 * FK to `alerts` is NO ACTION, ahead of deleting the site itself (PR #7117 T3).
 *
 * Why delete rather than detach: ownership is immutable
 * (`breeze_alerts_topology_ownership_guard`) and `alerts_topology_owner_chk`
 * forbids a source key without a site, and the site's whole topology domain
 * (policies, runs, outbox — every `topology_*` site FK is ON DELETE CASCADE)
 * goes with it, so an owned alert has nothing left to belong to. Device-bound
 * alerts and other sites' alerts are never touched.
 *
 * Children, mirroring the device cascade (services/deviceDeletion.ts):
 * alert_correlations / alert_notifications / psa_ticket_mappings are deleted,
 * log_correlations / network_change_events are detached; ON DELETE CASCADE
 * (ticket_alert_links, alert_correlation_members, ai_alert_verdicts) and
 * SET NULL children are left to Postgres.
 *
 * The caller must hold the site row `FOR UPDATE` (see lockSiteForDelete) so a
 * concurrent assessment cannot insert a new owned alert — its FK check takes a
 * KEY SHARE lock on the site row — between this delete and the site's.
 * Returns the number of owned alerts deleted.
 */
export async function deleteSiteOwnedTopologyAlerts(tx: SqlExecutor, orgId: string, siteId: string): Promise<number> {
  return deleteTopologyAlertsWhere(tx, sql`org_id = ${orgId}::uuid AND topology_site_id = ${siteId}::uuid`);
}

/**
 * Deletes the site-owned topology alerts whose ORIGIN device (alerts.device_id,
 * provenance only) is one of `deviceIds` — `deviceIds` is a SQL subquery or
 * list expression yielding device ids — with the same NO ACTION child sequence
 * as {@link deleteSiteOwnedTopologyAlerts}. `ownerOrgNot` restricts it to
 * alerts owned by a DIFFERENT org (org erasure leaves the org's own to the
 * walk). Returns the number deleted.
 *
 * Why this exists (PR #7117 re-review): the ownership guard pins a site-owned
 * alert's org_id to its SITE when the origin device moves org, but device_id
 * (NO ACTION FK) keeps pointing at the moved device. The device's new org
 * then holds a device a row in ANOTHER org still references, so a delete of
 * that device, or an erasure of its new org (which deletes alerts by org_id
 * only), must remove these first or the devices DELETE raises 23503. Matches
 * how device-bound alerts go with their device. Must run in a SYSTEM db
 * context: the alert may belong to an org the caller cannot see.
 */
export async function deleteOriginDeviceTopologyAlerts(
  tx: SqlExecutor,
  deviceIds: SQL,
  options: { ownerOrgNot?: string } = {},
): Promise<number> {
  const ownerFilter = options.ownerOrgNot ? sql` AND org_id <> ${options.ownerOrgNot}::uuid` : sql``;
  return deleteTopologyAlertsWhere(tx, sql`topology_site_id IS NOT NULL AND device_id IN (${deviceIds})${ownerFilter}`);
}

async function deleteTopologyAlertsWhere(tx: SqlExecutor, predicate: SQL): Promise<number> {
  const owned = sql`(SELECT id FROM alerts WHERE ${predicate})`;
  await tx.execute(sql`DELETE FROM alert_correlations WHERE parent_alert_id IN ${owned} OR child_alert_id IN ${owned}`);
  await tx.execute(sql`DELETE FROM alert_notifications WHERE alert_id IN ${owned}`);
  await tx.execute(sql`DELETE FROM psa_ticket_mappings WHERE alert_id IN ${owned}`);
  await tx.execute(sql`UPDATE log_correlations SET alert_id = NULL WHERE alert_id IN ${owned}`);
  await tx.execute(sql`UPDATE network_change_events SET alert_id = NULL WHERE alert_id IN ${owned}`);
  const deleted = await tx.execute(sql`DELETE FROM alerts WHERE ${predicate} RETURNING id`);
  return Array.isArray(deleted) ? deleted.length : 0;
}

/** Row-locks the site for its delete; false when RLS hides it or it is gone. */
export async function lockSiteForDelete(tx: SqlExecutor, siteId: string): Promise<boolean> {
  const rows = await tx.execute(sql`SELECT id FROM sites WHERE id = ${siteId}::uuid FOR UPDATE`);
  return (rows as unknown[]).length > 0;
}
