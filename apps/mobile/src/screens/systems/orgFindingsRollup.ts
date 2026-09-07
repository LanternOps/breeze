import { resolveOrgName } from './mergeSystemsResults';
import type { OrgRollup } from './useSystemsData';
import type { OrganizationSummary } from '../../services/systems';

/**
 * Fold open fleet-hygiene finding counts (#5139 / #5117 decision 1) into the
 * per-org rollups `useSystemsData` already builds from devices + active
 * alerts. Kept as a standalone pure function (rather than inline in the
 * `orgRollups` useMemo) so it can be unit-tested without importing
 * `useSystemsData.ts` itself, which pulls in React Native transitively.
 *
 * Creates a rollup for an org that has open findings but no devices/alerts
 * of its own — such an org would otherwise never appear in ORGANIZATIONS
 * even though it now has something to triage.
 */
export function foldFindingsIntoOrgRollups(
  rollups: readonly OrgRollup[],
  byOrg: Record<string, number> | undefined,
  orgs: ReadonlyArray<{ id: string; name: string }>,
  orgsFailed: boolean,
): OrgRollup[] {
  if (!byOrg) return [...rollups];

  const byId = new Map<string, OrgRollup>(rollups.map((r) => [r.id, { ...r }]));
  for (const [orgId, count] of Object.entries(byOrg)) {
    if (count <= 0) continue;
    const existing = byId.get(orgId);
    if (existing) {
      existing.issueCount += count;
    } else {
      const resolved = resolveOrgName(orgs, orgId, orgsFailed);
      byId.set(orgId, {
        id: orgId,
        name: resolved.name,
        deviceCount: 0,
        issueCount: count,
        // #5115: an org that has open findings but no devices/alerts of its
        // own has nothing to report as offline either.
        offlineCount: 0,
        nameUnavailable: resolved.unavailable,
      });
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (b.issueCount !== a.issueCount) return b.issueCount - a.issueCount;
    return a.name.localeCompare(b.name);
  });
}

export interface FindingsOrgSummary {
  orgId: string;
  orgName: string;
  count: number;
}

/**
 * Per-org open-finding summaries for the Systems ACTIVE ISSUES list (#5139):
 * one row per org with open findings, scoped to the active org filter when
 * one is set. Findings have no per-row detail here (only a count) — the
 * screen renders one summary row per org rather than one row per finding,
 * since the counts endpoint intentionally does not return individual finding
 * records (see routes/fleetFindings.ts's `/counts`).
 */
export function buildFindingsSummary(
  byOrg: Record<string, number> | undefined,
  orgs: ReadonlyArray<{ id: string; name: string }>,
  orgsFailed: boolean,
  filterOrgId: string | null,
): FindingsOrgSummary[] {
  const entries = Object.entries(byOrg ?? {}).filter(([, count]) => count > 0);
  const scoped = filterOrgId ? entries.filter(([orgId]) => orgId === filterOrgId) : entries;

  return scoped
    .map(([orgId, count]) => ({
      orgId,
      orgName: resolveOrgName(orgs, orgId, orgsFailed).name,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.orgName.localeCompare(b.orgName));
}
