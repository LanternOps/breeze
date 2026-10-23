// Fixtures for the alerts / vulnerabilities / threats count-parity families
// (dashboard A-2). Same two narrowing inputs as the devices families (ambient
// org + site allowlist), imported from parityFixtures. The fake servers mirror
// the real predicates:
//   GET /alerts/summary          bySeverity counts ACTIVE alerts only
//   GET /vulnerabilities/stats   counts findings (criticalOpen, patchReady) and
//                                distinct open KEV CVEs
//   GET /security/dashboard      activeThreats = status 'active' threat rows
import { ORG_A, ORG_B, SITE_A, SITE_B, SITE_C, type Session } from './parityFixtures';

const inScope = (x: { orgId: string; siteId: string }, s: Session): boolean =>
  (!s.orgId || x.orgId === s.orgId) && (!s.allowedSiteIds || s.allowedSiteIds.includes(x.siteId));

// ---- alerts ---------------------------------------------------------------
export interface FixtureAlert {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  status: 'active' | 'acknowledged' | 'resolved' | 'suppressed' | 'dismissed';
  orgId: string;
  siteId: string;
}

export const FIXTURE_ALERTS: FixtureAlert[] = [
  { id: 'a01', severity: 'critical', status: 'active', orgId: ORG_A, siteId: SITE_A },
  { id: 'a02', severity: 'critical', status: 'active', orgId: ORG_A, siteId: SITE_B },
  { id: 'a03', severity: 'high', status: 'active', orgId: ORG_A, siteId: SITE_A },
  { id: 'a04', severity: 'high', status: 'resolved', orgId: ORG_A, siteId: SITE_A },
  { id: 'a05', severity: 'critical', status: 'acknowledged', orgId: ORG_A, siteId: SITE_A },
  { id: 'a06', severity: 'medium', status: 'active', orgId: ORG_A, siteId: SITE_A },
  { id: 'a07', severity: 'medium', status: 'active', orgId: ORG_A, siteId: SITE_B },
  { id: 'a08', severity: 'medium', status: 'dismissed', orgId: ORG_A, siteId: SITE_A },
  { id: 'a09', severity: 'low', status: 'active', orgId: ORG_A, siteId: SITE_A },
  { id: 'a10', severity: 'critical', status: 'active', orgId: ORG_B, siteId: SITE_C },
  { id: 'a11', severity: 'medium', status: 'active', orgId: ORG_B, siteId: SITE_C },
];

/** GET /alerts: scoped, every status (the page filters client-side). */
export const alertListFor = (s: Session): FixtureAlert[] => FIXTURE_ALERTS.filter((a) => inScope(a, s));

/** GET /alerts/summary. */
export function alertSummaryFor(s: Session) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const a of alertListFor(s)) if (a.status === 'active') bySeverity[a.severity] += 1;
  return { bySeverity, byStatus: {}, total: alertListFor(s).length };
}

export interface AlertsParityExpectation {
  status: string;
  severities: string[];
  /** The tile's number, from the summary, as the card computes it. */
  tileCount: (summary: ReturnType<typeof alertSummaryFor>) => number;
}

const crit = (s: ReturnType<typeof alertSummaryFor>) => s.bySeverity.critical + s.bySeverity.high;
const warn = (s: ReturnType<typeof alertSummaryFor>) => s.bySeverity.medium;

export const ALERTS_PARITY: Record<string, AlertsParityExpectation> = {
  'kpi.critical': { status: 'active', severities: ['critical', 'high'], tileCount: crit },
  'alerts.criticalCount': { status: 'active', severities: ['critical', 'high'], tileCount: crit },
  'kpi.warnings': { status: 'active', severities: ['medium'], tileCount: warn },
  'alerts.warningCount': { status: 'active', severities: ['medium'], tileCount: warn },
};

// ---- vulnerabilities ------------------------------------------------------
export interface FixtureFinding {
  cveId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'accepted' | 'mitigated' | 'patched';
  kev: boolean;
  patchReady: boolean;
  orgId: string;
  siteId: string;
}

const finding = (
  cveId: string,
  severity: FixtureFinding['severity'],
  status: FixtureFinding['status'],
  kev: boolean,
  patchReady: boolean,
  orgId = ORG_A,
  siteId = SITE_A,
): FixtureFinding => ({ cveId, severity, status, kev, patchReady, orgId, siteId });

export const FIXTURE_FINDINGS: FixtureFinding[] = [
  finding('CVE-1', 'critical', 'open', true, true),
  finding('CVE-1', 'critical', 'open', true, true), // second device, same CVE
  finding('CVE-2', 'critical', 'open', false, false),
  finding('CVE-3', 'critical', 'patched', true, true),
  finding('CVE-4', 'high', 'open', true, false, ORG_A, SITE_B),
  finding('CVE-5', 'medium', 'open', false, true, ORG_A, SITE_B),
  finding('CVE-6', 'low', 'accepted', false, true),
  finding('CVE-7', 'critical', 'open', true, true, ORG_B, SITE_C),
  finding('CVE-8', 'high', 'open', false, true, ORG_B, SITE_C),
];

/** GET /vulnerabilities/stats (the fields the A-2 links rest on). */
export function vulnStatsFor(s: Session) {
  const open = FIXTURE_FINDINGS.filter((f) => inScope(f, s) && f.status === 'open');
  return {
    openFindings: open.length,
    criticalOpen: open.filter((f) => f.severity === 'critical').length,
    kevCveCount: new Set(open.filter((f) => f.kev).map((f) => f.cveId)).size,
    patchReadyFindingCount: open.filter((f) => f.patchReady).length,
  };
}

export interface VulnQuery {
  status?: string;
  severity?: string;
  kevOnly?: string;
  patchAvailable?: string;
}

/** GET /vulnerabilities?<query>: one row per CVE with the findings under it. */
export function vulnListFor(q: VulnQuery, s: Session): Array<{ cveId: string; findings: FixtureFinding[] }> {
  const byCve = new Map<string, FixtureFinding[]>();
  for (const f of FIXTURE_FINDINGS) {
    if (!inScope(f, s)) continue;
    if (q.status && q.status !== 'all' && f.status !== q.status) continue;
    if (q.severity && f.severity !== q.severity) continue;
    if (q.kevOnly === 'true' && !f.kev) continue;
    if (q.patchAvailable === 'true' && !f.patchReady) continue;
    byCve.set(f.cveId, [...(byCve.get(f.cveId) ?? []), f]);
  }
  return [...byCve].map(([cveId, findings]) => ({ cveId, findings }));
}

export interface VulnParityExpectation {
  /** The exact list query the destination must send. */
  query: VulnQuery;
  tileCount: (stats: ReturnType<typeof vulnStatsFor>) => number;
  /** What the tile counts: findings (list shows their CVEs) or the CVEs themselves. */
  grain: 'cves' | 'findings';
}

export const VULNS_PARITY: Record<string, VulnParityExpectation> = {
  // Header "N open findings" (stats.openFindings, status='open' only) -> "View open CVEs".
  'vuln.viewOpen': {
    query: { status: 'open' },
    tileCount: (s) => s.openFindings,
    grain: 'findings',
  },
  'vuln.viewCritical': {
    query: { status: 'open', severity: 'critical' },
    tileCount: (s) => s.criticalOpen,
    grain: 'findings',
  },
  'vuln.viewPatchReady': {
    query: { status: 'open', patchAvailable: 'true' },
    tileCount: (s) => s.patchReadyFindingCount,
    grain: 'findings',
  },
  'vuln.kevCves': {
    query: { status: 'open', kevOnly: 'true' },
    tileCount: (s) => s.kevCveCount,
    grain: 'cves',
  },
};

// ---- threats --------------------------------------------------------------
export interface FixtureThreat {
  id: string;
  status: 'active' | 'quarantined' | 'removed';
  orgId: string;
  siteId: string;
}

export const FIXTURE_THREATS: FixtureThreat[] = [
  { id: 't01', status: 'active', orgId: ORG_A, siteId: SITE_A },
  { id: 't02', status: 'active', orgId: ORG_A, siteId: SITE_B },
  { id: 't03', status: 'quarantined', orgId: ORG_A, siteId: SITE_A },
  { id: 't04', status: 'removed', orgId: ORG_A, siteId: SITE_A },
  { id: 't05', status: 'active', orgId: ORG_B, siteId: SITE_C },
];

/** GET /security/threats (every status; the page filters by ?status). */
export const threatListFor = (s: Session): FixtureThreat[] => FIXTURE_THREATS.filter((t) => inScope(t, s));
/** GET /security/dashboard activeThreats. */
export const activeThreatsFor = (s: Session): number => threatListFor(s).filter((t) => t.status === 'active').length;

export const THREATS_PARITY: Record<string, { status: string; tileCount: (s: Session) => number }> = {
  'security.threats': { status: 'active', tileCount: activeThreatsFor },
};
