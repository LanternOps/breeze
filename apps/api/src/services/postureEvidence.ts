// Shared evidence loader for the Security & Compliance Posture report AND the
// Trust Center snapshot (spec trust-center §5.3). One computation: both callers
// read the same counts; the evaluators own the denominators. Query ORDER is a
// contract (positional mocks in securityComplianceReport.test.ts):
//  1 organizations  2 devices  3 security_status  4 s1_agents  5 huntress_agents
//  6 device_patches pending+severity  [edr gate + edr_endpoints, when allowed]
//  7 dns  8 backup_configs  9 c2c  10 m365  11 google  12 pam_org_config
// 13 pam_rules  14 elevation_requests  (15 loadPartnerPolicy)  16 posture snapshot
// 17 cis (if includeCis)  [17b latest-scan findings, only if includeCisSafeguards]  18 device_patches scanned-set
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../db';
import { isEnforcing, loadPartnerPolicy } from './authenticatorPolicy';
import {
  backupConfigs,
  c2cConnections,
  devicePatches,
  devices,
  dnsFilterIntegrations,
  elevationRequests,
  googleWorkspaceConnections,
  huntressAgents,
  cisBaselineResults,
  m365Connections,
  organizations,
  OUTSTANDING_DEVICE_PATCH_STATUSES,
  pamOrgConfig,
  pamRules,
  patches,
  s1Agents,
  securityPostureOrgSnapshots,
  securityStatus,
  sites
} from '../db/schema';
import { EFFECTIVE_PATCH_SEVERITY_SQL } from './patchSeverityOverlay';
import type { securityCompliancePostureConfigSchema } from './reportConfigSchemas';
import type { OrgAxisLiveSiteScopeV1 } from './siteScope';
import {
  categoryForEndpointProvider,
  prettySecurityProvider,
  type SecurityProductEvidence
} from './securityComplianceReportProducts';
import { loadOpenVulnerabilityCounts } from './securityComplianceReportVulnerabilities';
import { loadBackupsVerifiedEvidence, loadM365MfaEvidence } from './postureEvidenceNetNew';
import { loadBackupProviderEvidence } from './securityComplianceReportBackupProviders';
import { EDR_PRODUCT_LABEL, loadEdrDeviceCoverage } from './securityComplianceReportEdr';
import { classifyDeviceProtection } from './portal/protection';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';
import {
  CIS_BENCHMARK_CHECK_SAFEGUARDS, emptyControlEvidence, safeguardsForCheck,
  type BenchmarkOs, type ControlEvidence, type PostureControlEvidence, type SafeguardEvidence,
} from '@breeze/shared';
import { trustCisFrameworkViewEnabled } from '../config/env';
import { cisFindingSchema } from '../db/schema/cisHardening';

export interface PostureEvidencePolicy {
  sites: string[];
  windowDays: number;
  minPasswordLength: number;
  maxLocalAdmins: number;
  maxAvDefinitionsAgeDays: number;
  maxSecurityStatusAgeDays: number;
  includeCis: boolean;
  /**
   * Trust Center W3e: also read the latest fresh scan's findings and report per-CIS-safeguard evidence under
   * hardening_baseline. Needs includeCis. Always false for the report path.
   */
  includeCisSafeguards: boolean;
  monitoringWindowHours: number;
}

export interface PostureEvidenceOptions {
  /**
   * EDR provider framework (#8166) gate. Evaluated where the report always
   * evaluated `edrReportEvidenceAllowed`; `loadEdrDeviceCoverage` runs only when
   * it resolves true. Absent → no EDR-framework evidence is read (S1/Huntress
   * agent rows still count).
   */
  edrEvidenceAllowed?: () => Promise<boolean>;
}

export function postureEvidencePolicyFromReportConfig(
  cfg: z.infer<typeof securityCompliancePostureConfigSchema>,
): PostureEvidencePolicy {
  return {
    sites: cfg.sites,
    windowDays: cfg.windowDays,
    minPasswordLength: cfg.minPasswordLength,
    maxLocalAdmins: cfg.maxLocalAdmins,
    maxAvDefinitionsAgeDays: cfg.maxAvDefinitionsAgeDays,
    maxSecurityStatusAgeDays: cfg.maxSecurityStatusAgeDays,
    includeCis: cfg.includeCis,
    includeCisSafeguards: false,
    monitoringWindowHours: 24,
  };
}

/** The trust page is the report's DEFAULT configuration, by reference (spec §5.2). */
export const TRUST_PAGE_EVIDENCE_POLICY: PostureEvidencePolicy = {
  sites: [],
  windowDays: 30,
  minPasswordLength: 8,
  maxLocalAdmins: 2,
  maxAvDefinitionsAgeDays: 7,
  maxSecurityStatusAgeDays: 30,
  includeCis: true,
  // Read at call time (not module load): the CIS framework view is a deployment switch operators flip.
  get includeCisSafeguards() { return trustCisFrameworkViewEnabled(); },
  monitoringWindowHours: 24,
};

export interface DeviceEvidenceRow {
  id: string;
  hostname: string;
  osType: string | null;
  siteName: string | null;
  lastSeenAt: Date | null;
  hasStatusRow: boolean;
  /** security_status row exists and is within maxSecurityStatusAgeDays (null age fails open as fresh). */
  statusFresh: boolean;
  /** Raw security_status.provider (null when no row). */
  nativeProvider: string | null;
  protection: ReturnType<typeof classifyDeviceProtection>;
  managed: string[];
  realTimeProtection: boolean | null;
  avDefinitionsAgeDays: number | null;
  /** Raw encryption status ('unknown' when no row); not freshness-gated. */
  encryption: string;
  /** Raw firewall reading; not freshness-gated. */
  firewall: boolean | null;
  localAdmins: number | null;
  patchAssessed: boolean;
  pendingPatches: number;
  criticalPatches: number;
  cisPassRate: number | null;
}

export interface OrgWideEvidence {
  dns: { isActive: boolean; provider: string; lastSyncStatus: string | null } | undefined;
  backup: { isActive: boolean; provider: string; encryption: unknown } | undefined;
  c2c: { status: string; provider: string } | undefined;
  m365: { status: string } | undefined;
  google: { status: string } | undefined;
  pamCfg: { uacInterceptionEnabled: boolean | null } | undefined;
  pamRuleRows: Array<{ id: string }>;
  elevationRows: Array<{ approvedAt: Date | null; deniedByUserId: string | null }>;
  mfaStepUpEnforced: boolean;
  postureRow: { overallScore: number } | undefined;
}

export interface PostureEvidence {
  asOf: string;
  org: { id: string; name: string; partnerId: string | null } | null;
  scopeKind: 'unrestricted' | 'restricted';
  deviceCount: number;
  devices: DeviceEvidenceRow[];
  controls: PostureControlEvidence;
  report: {
    reporting: number;
    unprotected: number;
    cisIncluded: boolean;
    cisAssessedCount: number;
    edrUnknown: number;
    anyAvUnknown: number;
    orgWide: OrgWideEvidence | null;
    backupProviders: { evidence: SecurityProductEvidence[]; coveredDeviceCount: number };
    vulnByDevice: Map<string, { critical: number; high: number }>;
    /** The report's security-product inventory input, assembled here. */
    productEvidence: SecurityProductEvidence[];
  };
}

const daysAgo = (asOf: Date, d: Date | null | undefined): number | null =>
  d ? Math.floor((asOf.getTime() - new Date(d).getTime()) / 86400000) : null;
const isString = (value: unknown): value is string => typeof value === 'string';
/**
 * Per-device evidence age (spec §5.4 `assessed`, §19 item 18): evidence older
 * than maxDays is not evidence. An unparseable timestamp is stale. A null one
 * fails open as fresh: every column read here is NOT NULL in the schema
 * (security_status.updated_at, device_patches.updated_at,
 * cis_baseline_results.checked_at), so null is a legacy/edge row only.
 */
const withinDays = (asOf: Date, d: Date | null | undefined, maxDays: number): boolean => {
  if (d == null) return true;
  const age = daysAgo(asOf, d);
  return age != null && Number.isFinite(age) && age <= maxDays;
};
const newestDate = (...ds: Array<Date | null | undefined>): Date | null => {
  let best: Date | null = null;
  for (const d of ds) {
    if (!d) continue;
    const t = new Date(d).getTime();
    if (!Number.isFinite(t)) continue;
    if (!best || t > best.getTime()) best = new Date(t);
  }
  return best;
};
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const newer = (a: string | null, d: Date | null | undefined): string | null => {
  const b = iso(d);
  if (!b) return a;
  return !a || b > a ? b : a;
};

export function prettyDnsProvider(p: string): string {
  const map: Record<string, string> = {
    umbrella: 'Cisco Umbrella',
    cloudflare: 'Cloudflare Gateway',
    dnsfilter: 'DNSFilter',
    pihole: 'Pi-hole',
    opendns: 'OpenDNS',
    quad9: 'Quad9',
    adguard_home: 'AdGuard Home'
  };
  return map[p] ?? `DNS filtering (${p})`;
}

/**
 * Tri-state password-policy evaluation: `null` when the device reported no usable
 * policy object (unknown — exclude from the denominator), otherwise pass/fail.
 * Never collapses "no data" into a fail.
 */
export function passwordComplexityResult(summary: unknown, minLength: number): boolean | null {
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as Record<string, unknown>;
  const hasLen = typeof s.minLength === 'number';
  const hasLockout = typeof s.lockoutThreshold === 'number' || typeof s.lockoutEnabled === 'boolean';
  if (!hasLen && !hasLockout) return null; // object present but no recognizable policy fields
  const len = typeof s.minLength === 'number' ? s.minLength : 0;
  const lockout =
    typeof s.lockoutThreshold === 'number' ? s.lockoutThreshold > 0 : Boolean(s.lockoutEnabled);
  return len >= minLength && lockout;
}

export function localAdminCount(summary: unknown): number | null {
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as Record<string, unknown>;
  return typeof s.adminCount === 'number' ? s.adminCount : null;
}

const BENCHMARK_OSES = new Set<string>(Object.keys(CIS_BENCHMARK_CHECK_SAFEGUARDS));

/**
 * Per-safeguard hardening evidence (W3e). A device is ELIGIBLE for a safeguard when its OS has at least one agent
 * check mapped to it; ASSESSED when its fresh latest scan holds a pass/fail result for one of those checks
 * (not_applicable and error assess nothing); PASSING when none of those results failed. Counts only.
 */
function computeSafeguardEvidence(
  deviceRows: ReadonlyArray<{ id: string; osType: string | null }>,
  freshScans: ReadonlyMap<string, { checkedAt: Date | null }>,
  findingsByDevice: ReadonlyMap<string, ReadonlyArray<{ checkId: string; status: string }>>,
): Record<string, SafeguardEvidence> {
  const out: Record<string, SafeguardEvidence> = {};
  const slot = (ref: string): SafeguardEvidence => (out[ref] ??= { eligible: 0, assessed: 0, passing: 0, newestEvidenceAt: null });
  for (const d of deviceRows) {
    const os = d.osType ?? '';
    if (!BENCHMARK_OSES.has(os)) continue;
    const table = CIS_BENCHMARK_CHECK_SAFEGUARDS[os as BenchmarkOs];
    const eligibleRefs = new Set<string>();
    for (const refs of Object.values(table)) for (const ref of refs) eligibleRefs.add(ref);
    for (const ref of eligibleRefs) slot(ref).eligible += 1;

    const scan = freshScans.get(d.id);
    if (!scan) continue;
    const tally = new Map<string, { fail: number; seen: number }>();
    for (const f of findingsByDevice.get(d.id) ?? []) {
      if (f.status !== 'pass' && f.status !== 'fail') continue;
      for (const ref of safeguardsForCheck(os, f.checkId)) {
        const t = tally.get(ref) ?? { fail: 0, seen: 0 };
        t.seen += 1;
        if (f.status === 'fail') t.fail += 1;
        tally.set(ref, t);
      }
    }
    for (const [ref, t] of tally) {
      const s = slot(ref);
      s.assessed += 1;
      if (t.fail === 0) s.passing += 1;
      s.newestEvidenceAt = newer(s.newestEvidenceAt, scan.checkedAt);
    }
  }
  return out;
}

function bump(c: ControlEvidence, assessed: boolean, passing: boolean, evidenceAt?: Date | null): void {
  c.eligible += 1;
  if (!assessed) return;
  c.assessed += 1;
  if (passing) c.passing += 1;
  c.newestEvidenceAt = newer(c.newestEvidenceAt, evidenceAt);
}

/** Org-wide configuration fact. No real timestamp is selected for these, so none is reported:
 *  snapshot time is not evidence time (spec §5.4), and stamping `asOf` would change every snapshot's hash. */
function orgFact(c: ControlEvidence, known: boolean, value: boolean): void {
  c.eligible = 1;
  if (!known) return;
  c.assessed = 1;
  c.passing = value ? 1 : 0;
  c.newestEvidenceAt = null;
}

export async function loadPostureEvidence(
  scope: OrgAxisLiveSiteScopeV1,
  policy: PostureEvidencePolicy,
  asOf: Date,
  opts: PostureEvidenceOptions = {},
): Promise<PostureEvidence> {
  const orgId = scope.orgId;
  const controls = emptyControlEvidence();
  const empty = (orgWide: OrgWideEvidence | null, org: PostureEvidence['org']): PostureEvidence => ({
    asOf: asOf.toISOString(),
    org,
    scopeKind: scope.kind,
    deviceCount: 0,
    devices: [],
    controls,
    report: {
      reporting: 0,
      unprotected: 0,
      cisIncluded: policy.includeCis,
      cisAssessedCount: 0,
      edrUnknown: 0,
      anyAvUnknown: 0,
      orgWide,
      backupProviders: { evidence: [], coveredDeviceCount: 0 },
      vulnByDevice: new Map(),
      productEvidence: orgWide ? assembleProductEvidence({ orgWide, backupEvidence: [] }) : [],
    },
  });

  if (scope.kind === 'restricted' && scope.siteIds.length === 0) return empty(null, null);

  // 1 organizations
  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const org = orgRow ? { id: orgRow.id, name: orgRow.name, partnerId: orgRow.partnerId ?? null } : null;

  // 2 devices. Ephemeral Quick Support devices stay inside accessibleOrgIds for
  // RLS by design — exclude them from the compliance population explicitly.
  // Decommissioned devices are excluded (spec §19.6; matches securityPostureWorker).
  const deviceConditions = [
    eq(devices.orgId, orgId),
    eq(devices.isEphemeral, false),
    notParkedDeviceCondition(),
    ne(devices.status, 'decommissioned'),
  ];
  if (policy.sites.length > 0) {
    deviceConditions.push(inArray(devices.siteId, policy.sites));
  }
  if (scope.kind === 'restricted') {
    deviceConditions.push(inArray(devices.siteId, scope.siteIds));
  }
  const deviceRows = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      osType: devices.osType,
      siteName: sites.name,
      lastSeenAt: devices.lastSeenAt
    })
    .from(devices)
    .leftJoin(sites, eq(devices.siteId, sites.id))
    .where(and(...deviceConditions));
  const deviceIds = deviceRows.map((d) => d.id);

  const includeOrgWide = scope.kind === 'unrestricted';
  // Org-wide evidence (queries 7–16) is independent of the device population;
  // it is loaded even for zero devices so the trust page can show
  // identity/DNS/privileged-access.
  const loadOrgWide = async (): Promise<OrgWideEvidence> => {
    const [dns] = await db
      .select({ isActive: dnsFilterIntegrations.isActive, provider: dnsFilterIntegrations.provider, lastSyncStatus: dnsFilterIntegrations.lastSyncStatus })
      .from(dnsFilterIntegrations)
      .where(and(eq(dnsFilterIntegrations.orgId, orgId), eq(dnsFilterIntegrations.isActive, true)))
      .limit(1);
    const [backup] = await db
      .select({ isActive: backupConfigs.isActive, provider: backupConfigs.provider, encryption: backupConfigs.encryption })
      .from(backupConfigs)
      .where(and(eq(backupConfigs.orgId, orgId), eq(backupConfigs.isActive, true)))
      .limit(1);
    const [c2c] = await db
      .select({ status: c2cConnections.status, provider: c2cConnections.provider })
      .from(c2cConnections)
      .where(and(eq(c2cConnections.orgId, orgId), eq(c2cConnections.status, 'active')))
      .limit(1);
    const [m365] = await db
      .select({ status: m365Connections.status })
      .from(m365Connections)
      .where(and(eq(m365Connections.orgId, orgId), eq(m365Connections.status, 'active')))
      .limit(1);
    const [google] = await db
      .select({ status: googleWorkspaceConnections.status })
      .from(googleWorkspaceConnections)
      .where(and(eq(googleWorkspaceConnections.orgId, orgId), eq(googleWorkspaceConnections.status, 'active')))
      .limit(1);

    const [pamCfg] = await db
      .select({ uacInterceptionEnabled: pamOrgConfig.uacInterceptionEnabled })
      .from(pamOrgConfig)
      .where(eq(pamOrgConfig.orgId, orgId))
      .limit(1);
    const pamRuleRows = await db
      .select({ id: pamRules.id })
      .from(pamRules)
      .where(and(eq(pamRules.orgId, orgId), eq(pamRules.enabled, true)));
    const windowStart = new Date(asOf.getTime() - policy.windowDays * 86400000);
    const elevationRows = await db
      .select({ approvedAt: elevationRequests.approvedAt, deniedByUserId: elevationRequests.deniedByUserId })
      .from(elevationRequests)
      .where(and(eq(elevationRequests.orgId, orgId), gte(elevationRequests.requestedAt, windowStart)));

    // Step-up counts as enforced when under-assured high AND critical
    // approvals are refused right now — an explicit Required policy past its
    // grace date, or the platform default once it applies. Read through
    // loadPartnerPolicy (system-context partner-axis read) so an explicit
    // "not required" row is never hidden and mistaken for the default.
    const authPol = org?.partnerId ? await loadPartnerPolicy(org.partnerId) : null;
    const mfaStepUpEnforced =
      isEnforcing(authPol, asOf, 'high') && isEnforcing(authPol, asOf, 'critical');

    const [postureRow] = await db
      .select({ overallScore: securityPostureOrgSnapshots.overallScore })
      .from(securityPostureOrgSnapshots)
      .where(eq(securityPostureOrgSnapshots.orgId, orgId))
      .orderBy(desc(securityPostureOrgSnapshots.capturedAt))
      .limit(1);

    return { dns, backup, c2c, m365, google, pamCfg, pamRuleRows, elevationRows, mfaStepUpEnforced, postureRow };
  };

  if (deviceIds.length === 0) {
    const orgWide = includeOrgWide ? await loadOrgWide() : null;
    const out = empty(orgWide, org);
    if (orgWide) applyOrgWide(out.controls, orgWide);
    // maxSecurityStatusAgeDays IS the evidence-age window (spec §5.4); windowDays is the elevation-activity window.
    if (includeOrgWide) out.controls.mfa_registered_m365 = await loadM365MfaEvidence(orgId, asOf, policy.maxSecurityStatusAgeDays);
    return out;
  }

  // 3 security_status
  const ssRows = await db
    .select({
      deviceId: securityStatus.deviceId,
      provider: securityStatus.provider,
      realTimeProtection: securityStatus.realTimeProtection,
      definitionsDate: securityStatus.definitionsDate,
      encryptionStatus: securityStatus.encryptionStatus,
      firewallEnabled: securityStatus.firewallEnabled,
      passwordPolicySummary: securityStatus.passwordPolicySummary,
      localAdminSummary: securityStatus.localAdminSummary,
      updatedAt: securityStatus.updatedAt
    })
    .from(securityStatus)
    .where(and(eq(securityStatus.orgId, orgId), inArray(securityStatus.deviceId, deviceIds)));
  const ssByDevice = new Map(ssRows.map((r) => [r.deviceId, r]));

  // 4 s1_agents, 5 huntress_agents
  const s1Rows = await db
    .select({ deviceId: s1Agents.deviceId })
    .from(s1Agents)
    .where(and(eq(s1Agents.orgId, orgId), inArray(s1Agents.deviceId, deviceIds)));
  const huntressRows = await db
    .select({ deviceId: huntressAgents.deviceId })
    .from(huntressAgents)
    .where(and(eq(huntressAgents.orgId, orgId), inArray(huntressAgents.deviceId, deviceIds)));
  const s1Devices = new Set(s1Rows.map((r) => r.deviceId).filter(isString));
  const huntressDevices = new Set(huntressRows.map((r) => r.deviceId).filter(isString));

  // 6 device_patches pending + effective severity
  const patchRows = await db
    // Effective per-device severity (patchSeverityOverlay.ts) — see the same
    // note in securityPosture.ts. Per device_patches row, inside a query
    // already scoped to this org + these deviceIds; never mixed across orgs.
    .select({ deviceId: devicePatches.deviceId, severity: EFFECTIVE_PATCH_SEVERITY_SQL })
    .from(devicePatches)
    .innerJoin(patches, eq(devicePatches.patchId, patches.id))
    .where(
      and(
        eq(devicePatches.orgId, orgId),
        inArray(devicePatches.deviceId, deviceIds),
        inArray(devicePatches.status, OUTSTANDING_DEVICE_PATCH_STATUSES)
      )
    );
  const pendingByDevice = new Map<string, { total: number; critical: number }>();
  for (const p of patchRows) {
    const e = pendingByDevice.get(p.deviceId) ?? { total: 0, critical: 0 };
    e.total += 1;
    if (p.severity === 'critical') e.critical += 1;
    pendingByDevice.set(p.deviceId, e);
  }

  const vulnByDevice = await loadOpenVulnerabilityCounts(deviceIds);
  // Device-scoped like the Huntress/SentinelOne evidence above, so it is
  // included for a site-restricted caller too — limited to their devices.
  const backupProviders = await loadBackupProviderEvidence(orgId, deviceIds);
  // EDR provider framework (#8164): devices an EDR connector reports healthy.
  // Same device scoping as the Huntress/SentinelOne evidence above. The caller
  // decides the gate (a portal run honours the strict portal EDR flag).
  const edrDevices = opts.edrEvidenceAllowed && (await opts.edrEvidenceAllowed())
    ? await loadEdrDeviceCoverage(orgId, deviceIds)
    : new Set<string>();

  // 7–16 org-wide
  const orgWide = includeOrgWide ? await loadOrgWide() : null;

  // 17 cis — hardening pass-rate per device (latest scan), optional via policy.includeCis.
  // Uses the result's aggregate columns directly — no findings-jsonb parsing needed.
  // Only a scan inside the evidence-age window counts; a device whose LATEST
  // scan is stale is not assessed (an older scan is staler still).
  const cisByDevice = new Map<string, { pct: number; checkedAt: Date | null }>();
  const cisSeen = new Set<string>();
  const cisFreshResultIds: string[] = [];
  if (policy.includeCis) {
    const cisRows = await db
      .select({
        id: cisBaselineResults.id,
        deviceId: cisBaselineResults.deviceId,
        passedChecks: cisBaselineResults.passedChecks,
        totalChecks: cisBaselineResults.totalChecks,
        checkedAt: cisBaselineResults.checkedAt
      })
      .from(cisBaselineResults)
      .where(and(eq(cisBaselineResults.orgId, orgId), inArray(cisBaselineResults.deviceId, deviceIds)))
      .orderBy(desc(cisBaselineResults.checkedAt));
    for (const r of cisRows) {
      if (cisSeen.has(r.deviceId)) continue; // desc order → first seen is the latest scan
      cisSeen.add(r.deviceId);
      if (!withinDays(asOf, r.checkedAt, policy.maxSecurityStatusAgeDays)) continue;
      cisByDevice.set(r.deviceId, {
        pct: r.totalChecks > 0 ? Math.round((r.passedChecks / r.totalChecks) * 100) : 0,
        checkedAt: r.checkedAt ?? null,
      });
      if (r.id) cisFreshResultIds.push(r.id);
    }
  }

  // 17b W3e — findings of ONLY the latest fresh scan per device (never the history), when asked for. Failing to
  // parse one element skips that element, not the device.
  const safeguardFindings = new Map<string, Array<{ checkId: string; status: string }>>();
  if (policy.includeCis && policy.includeCisSafeguards && cisFreshResultIds.length > 0) {
    const findingRows = await db
      .select({ deviceId: cisBaselineResults.deviceId, findings: cisBaselineResults.findings })
      .from(cisBaselineResults)
      .where(and(eq(cisBaselineResults.orgId, orgId), inArray(cisBaselineResults.id, cisFreshResultIds)));
    for (const r of findingRows) {
      const parsed: Array<{ checkId: string; status: string }> = [];
      for (const el of Array.isArray(r.findings) ? r.findings : []) {
        const p = cisFindingSchema.safeParse(el);
        if (p.success) parsed.push({ checkId: p.data.checkId, status: p.data.status });
      }
      safeguardFindings.set(r.deviceId, parsed);
    }
  }

  // 18 Patch-assessed set: a device counts toward patch currency only if it has at
  // least one device_patches row (any status) whose newest of updatedAt /
  // lastCheckedAt is inside the evidence-age window. Absence of (recent) patch
  // data is "unknown", never silently scored as "current". (db.select —
  // selectDistinct isn't mocked.)
  const patchRowDevices = await db
    .select({ deviceId: devicePatches.deviceId, updatedAt: devicePatches.updatedAt, lastCheckedAt: devicePatches.lastCheckedAt })
    .from(devicePatches)
    .where(and(eq(devicePatches.orgId, orgId), inArray(devicePatches.deviceId, deviceIds)));
  const patchEvidenceAt = new Map<string, Date | null>();
  const patchScannedDevices = new Set<string>();
  for (const r of patchRowDevices) {
    const at = newestDate(r.updatedAt, r.lastCheckedAt);
    const rowFresh = at ? withinDays(asOf, at, policy.maxSecurityStatusAgeDays) : r.updatedAt == null && r.lastCheckedAt == null;
    if (!rowFresh) continue;
    patchScannedDevices.add(r.deviceId);
    const prev = patchEvidenceAt.get(r.deviceId) ?? null;
    patchEvidenceAt.set(r.deviceId, newestDate(prev, at));
  }

  // 19 (unrestricted only) + 20/21 — net-new readers. Appended last: the positional
  // db.select mocks in the loader/report tests depend on query order.
  // maxSecurityStatusAgeDays IS the evidence-age window (spec §5.4); windowDays is the elevation-activity window.
  if (includeOrgWide) controls.mfa_registered_m365 = await loadM365MfaEvidence(orgId, asOf, policy.maxSecurityStatusAgeDays);
  controls.backups_verified = await loadBackupsVerifiedEvidence(orgId, deviceIds, asOf, policy.maxSecurityStatusAgeDays);

  let reporting = 0; // devices reporting a security_status row
  let unprotected = 0;
  let edrUnknown = 0;
  let anyAvUnknown = 0;
  const monitoringCutoff = asOf.getTime() - policy.monitoringWindowHours * 3600_000;
  const evidenceCutoff = asOf.getTime() - policy.maxSecurityStatusAgeDays * 86400000;

  // Each control tracks an "assessed" denominator separate from `reporting`, so a
  // device that reported security_status but lacks data for a given control is an
  // explicit unknown — never folded into pass or fail.
  const rows: DeviceEvidenceRow[] = deviceRows.map((d) => {
    const ss = ssByDevice.get(d.id);
    const managed: string[] = [];
    if (huntressDevices.has(d.id)) managed.push('Huntress');
    if (s1Devices.has(d.id)) managed.push('SentinelOne');
    // Generic label: the report is a customer deliverable (see
    // securityComplianceReportEdr.ts), so the EDR vendor is never named.
    if (edrDevices.has(d.id)) managed.push(EDR_PRODUCT_LABEL);
    const isManaged = managed.length > 0;
    const rtp = ss?.realTimeProtection ?? null;
    const hasNativeAv = Boolean(ss && ss.provider && ss.provider !== 'other' && ss.provider !== 'unknown' && rtp === true);

    // A healthy EDR endpoint is managed protection, exactly like an S1 or
    // Huntress agent (it outranks native AV state).
    const protection = edrDevices.has(d.id)
      ? 'protected'
      : classifyDeviceProtection({
          securityStatus: ss
            ? {
                provider: ss.provider,
                realTimeProtection: ss.realTimeProtection,
              }
            : null,
          hasS1Agent: s1Devices.has(d.id),
          hasHuntressAgent: huntressDevices.has(d.id),
        });

    if (ss) reporting += 1;
    // The report has no unknown protection bucket. An absent status row (and a
    // null real-time-protection reading) has always counted as unprotected
    // here, so preserve that public contract.
    if (protection !== 'protected') unprotected += 1;

    // Firewall/encryption are live device states that stop updating when a device
    // goes offline, so a row older than the cutoff is treated as unknown rather
    // than counted as a current pass/fail. The same age gate applies to every
    // status-derived control (spec §19 item 18).
    const ssFresh = Boolean(ss) && withinDays(asOf, ss?.updatedAt, policy.maxSecurityStatusAgeDays);

    // Spec §19.7: a device is ASSESSED for EDR/AV when Breeze has any evidence
    // about it — a FRESH status row, an agent row, or a recent check-in.
    const lastSeenAt = d.lastSeenAt ?? null;
    const lastSeenMs = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
    const seenRecently = Number.isFinite(lastSeenMs) && lastSeenMs >= evidenceCutoff;
    const epAssessed = ssFresh || isManaged || seenRecently;
    const epEvidenceAt = ssFresh ? ss!.updatedAt : lastSeenAt;
    if (!epAssessed) {
      edrUnknown += 1;
      anyAvUnknown += 1;
    }
    bump(controls.edr_coverage, epAssessed, isManaged, epEvidenceAt);
    bump(controls.endpoint_protection, epAssessed, protection === 'protected', epEvidenceAt);

    const enc = ss?.encryptionStatus ?? 'unknown';
    bump(controls.disk_encryption, ssFresh && enc !== 'unknown', enc === 'encrypted', ss?.updatedAt);
    bump(
      controls.host_firewall,
      Boolean(ss && ssFresh && ss.firewallEnabled != null),
      ss?.firewallEnabled === true,
      ss?.updatedAt,
    );
    const pw = ss ? passwordComplexityResult(ss.passwordPolicySummary, policy.minPasswordLength) : null;
    bump(controls.password_policy, ssFresh && pw !== null, pw === true, ss?.updatedAt);
    const admins = ss ? localAdminCount(ss.localAdminSummary) : null;
    // passing = within the limit; the report's exposure is assessed - passing.
    bump(controls.least_privilege, ssFresh && admins != null, admins != null && admins <= policy.maxLocalAdmins, ss?.updatedAt);

    const pend = pendingByDevice.get(d.id) ?? { total: 0, critical: 0 };
    const patchAssessed = patchScannedDevices.has(d.id);
    bump(controls.os_patch_currency, patchAssessed, pend.critical === 0, patchEvidenceAt.get(d.id) ?? lastSeenAt);

    // AV definitions currency honors maxAvDefinitionsAgeDays, over native-AV
    // devices that report a definitions date (managed-EDR-only devices have none).
    const avAge = ss ? daysAgo(asOf, ss.definitionsDate) : null;
    bump(
      controls.definitions_current,
      ssFresh && hasNativeAv && avAge != null,
      avAge != null && avAge <= policy.maxAvDefinitionsAgeDays,
      ss?.definitionsDate,
    );

    const cis = cisByDevice.get(d.id);
    // Informational only: the evaluator scores pass_rate from aggregatePct.
    bump(controls.hardening_baseline, Boolean(cis), Boolean(cis && cis.pct >= 95), cis?.checkedAt); // cisByDevice holds fresh scans only

    // Continuous monitoring: every eligible device is assessed; passing = checked in within the window.
    bump(
      controls.continuous_monitoring,
      true,
      lastSeenAt ? new Date(lastSeenAt).getTime() >= monitoringCutoff : false,
      lastSeenAt,
    );

    return {
      id: d.id,
      hostname: d.hostname,
      osType: d.osType ?? null,
      siteName: d.siteName ?? null,
      lastSeenAt,
      hasStatusRow: Boolean(ss),
      statusFresh: ssFresh,
      nativeProvider: ss?.provider ?? null,
      protection,
      managed,
      realTimeProtection: rtp,
      avDefinitionsAgeDays: avAge,
      encryption: enc,
      firewall: ss?.firewallEnabled ?? null,
      localAdmins: admins,
      patchAssessed,
      pendingPatches: pend.total,
      criticalPatches: pend.critical,
      cisPassRate: cis?.pct ?? null,
    };
  });

  const cisValues = [...cisByDevice.values()].map((v) => v.pct);
  controls.hardening_baseline.aggregatePct =
    policy.includeCis && cisValues.length > 0
      ? Math.round(cisValues.reduce((a, b) => a + b, 0) / cisValues.length)
      : null;

  if (policy.includeCis && policy.includeCisSafeguards) {
    controls.hardening_baseline.safeguards = computeSafeguardEvidence(deviceRows, cisByDevice, safeguardFindings);
  }

  if (orgWide) applyOrgWide(controls, orgWide);

  // Security-product inventory input — moved from the report, order preserved.
  const deviceProductEvidence: SecurityProductEvidence[] = [];
  if (huntressDevices.size > 0) {
    deviceProductEvidence.push({ product: 'Huntress', category: 'mdr', active: true, lastSyncStatus: null, deviceIds: huntressDevices });
  }
  if (s1Devices.size > 0) {
    deviceProductEvidence.push({ product: 'SentinelOne', category: 'edr', active: true, lastSyncStatus: null, deviceIds: s1Devices });
  }
  if (edrDevices.size > 0) {
    deviceProductEvidence.push({ product: EDR_PRODUCT_LABEL, category: 'edr', active: true, lastSyncStatus: null, deviceIds: edrDevices });
  }
  for (const row of ssRows) {
    if (row.provider === 'other' || row.provider === 'unknown') continue;
    deviceProductEvidence.push({
      product: prettySecurityProvider(row.provider),
      category: categoryForEndpointProvider(row.provider),
      active: row.realTimeProtection === true,
      lastSyncStatus: null,
      deviceIds: [row.deviceId]
    });
  }
  const productEvidence = [
    ...deviceProductEvidence,
    ...assembleProductEvidence({ orgWide, backupEvidence: backupProviders.evidence }),
  ];

  return {
    asOf: asOf.toISOString(),
    org,
    scopeKind: scope.kind,
    deviceCount: deviceRows.length,
    devices: rows,
    controls,
    report: {
      reporting,
      unprotected,
      cisIncluded: policy.includeCis,
      cisAssessedCount: cisByDevice.size,
      edrUnknown,
      anyAvUnknown,
      orgWide,
      backupProviders,
      vulnByDevice,
      productEvidence,
    },
  };
}

/**
 * Org-wide and third-party-backup product entries, in the report's order:
 * dns, backup, c2c, third-party backup providers, m365, google. Third-party
 * backup evidence is device-scoped, so it is included for a restricted scope
 * (orgWide null) too.
 */
function assembleProductEvidence(input: {
  orgWide: OrgWideEvidence | null;
  backupEvidence: SecurityProductEvidence[];
}): SecurityProductEvidence[] {
  const w = input.orgWide;
  const out: SecurityProductEvidence[] = [];
  // An integration that exists but is failing to sync is not "active" for the
  // purpose of an attestation. Treat lastSyncStatus 'error' as degraded.
  const dnsSyncStatus = w?.dns?.lastSyncStatus ?? null;
  const dnsActive = Boolean(w?.dns) && dnsSyncStatus !== 'error';
  if (w?.dns) out.push({ product: prettyDnsProvider(w.dns.provider), category: 'dns_filtering', active: dnsActive, lastSyncStatus: dnsSyncStatus });
  if (w?.backup) out.push({ product: `Backup (${w.backup.provider})`, category: 'backup', active: true, lastSyncStatus: null });
  if (w?.c2c) out.push({ product: `SaaS backup (${w.c2c.provider})`, category: 'backup', active: true, lastSyncStatus: null });
  out.push(...input.backupEvidence);
  if (w?.m365) out.push({ product: 'Microsoft 365', category: 'identity', active: true, lastSyncStatus: null });
  if (w?.google) out.push({ product: 'Google Workspace', category: 'identity', active: true, lastSyncStatus: null });
  return out;
}

function applyOrgWide(controls: PostureControlEvidence, w: OrgWideEvidence): void {
  orgFact(controls.identity_provider, true, Boolean(w.m365 || w.google));
  const dnsSync = w.dns?.lastSyncStatus ?? null;
  orgFact(controls.dns_filtering, true, Boolean(w.dns) && dnsSync !== 'error');
  orgFact(controls.privileged_access, true, w.pamRuleRows.length > 0 || w.mfaStepUpEnforced);
}
