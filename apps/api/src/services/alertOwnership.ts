/**
 * The site that OWNS an alert for site-axis authorization and delivery
 * routing (topology M3-D6): a topology policy alert belongs to its topology
 * site — its origin device is provenance only and may since have moved site
 * or org; every other alert follows its device's CURRENT site.
 *
 * Pure and dependency-free so the in-memory gates (by-id reads, batch
 * filters) and the notification router share one rule. The SQL forms live in
 * routes/alerts/helpers.ts.
 */
export function alertOwningSiteId(
  alert: { topologySiteId?: string | null },
  deviceSiteId: string | null | undefined,
): string | null {
  return alert.topologySiteId ?? deviceSiteId ?? null;
}
