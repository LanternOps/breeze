import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  authenticatorPolicies,
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
import { securityCompliancePostureConfigSchema } from '../routes/reports/schemas';
import type { PostureSummary } from '@breeze/shared';
import { canAccessSite, type UserPermissions } from './permissions';
import { resolveSiteAllowedDeviceIds, type ReportResult } from './reportGenerationService';
import {
  buildSecurityProductInventory,
  categoryForEndpointProvider,
  prettySecurityProvider,
  type SecurityProductEvidence
} from './securityComplianceReportProducts';
import { loadOpenVulnerabilityCounts } from './securityComplianceReportVulnerabilities';

const pct = (num: number, denom: number): number =>
  denom === 0 ? 0 : Math.round((num / denom) * 100);

/**
 * Percentage that returns null (not 0) when nothing was assessed, so the PDF can
 * render "N/A — no data" instead of a misleading "0%". Critical for an insurance
 * report: an unmeasured control must never read as a measured failure or pass.
 */
const pctOrNull = (num: number, denom: number): number | null =>
  denom === 0 ? null : Math.round((num / denom) * 100);

const daysAgo = (d: Date | null): number | null =>
  d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null;

const isString = (value: unknown): value is string => typeof value === 'string';

/** Build a human label for a device's detected protection products. */
function protectionLabel(opts: {
  managed: string[];
  nativeProvider: string | null;
  rtp: boolean | null;
}): string {
  const parts = [...opts.managed];
  if (opts.nativeProvider && opts.nativeProvider !== 'other') {
    parts.push(prettySecurityProvider(opts.nativeProvider));
  }
  if (parts.length === 0) return 'None detected';
  const rtp = opts.rtp === true ? ' (RTP on)' : opts.rtp === false ? ' (RTP off)' : '';
  return parts.join(' + ') + rtp;
}

/**
 * Tri-state password-policy evaluation: `null` when the device reported no usable
 * policy object (unknown — exclude from the denominator), otherwise pass/fail.
 * Never collapses "no data" into a fail.
 */
function passwordComplexityResult(summary: unknown, minLength: number): boolean | null {
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

function localAdminCount(summary: unknown): number | null {
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as Record<string, unknown>;
  return typeof s.adminCount === 'number' ? s.adminCount : null;
}

function emptySummary(
  orgRow: { id: string; name: string } | undefined,
  generatedAt: string,
  includeCis = true,
  backupRequired = true
) {
  return {
    org: { id: orgRow?.id ?? '', name: orgRow?.name ?? 'Unknown' },
    generatedAt,
    deviceCount: 0,
    controls: {
      edrCoveragePct: null,
      anyAvCoveragePct: null,
      unprotectedCount: 0,
      encryptionPct: null,
      firewallPct: null,
      patchCurrentPct: null,
      patchUnknownCount: 0,
      passwordComplexityPct: null,
      passwordUnknownCount: 0,
      localAdminExposurePct: null,
      localAdminUnknownCount: 0,
      avDefinitionsCurrentPct: null,
      cisAvgPassRate: null,
      cisIncluded: includeCis,
      cisAssessedCount: 0,
      identityProviderConnected: false,
      backupRequired,
      backupConfigured: false,
      backupEncrypted: null,
      dnsFilteringActive: false,
      dnsFilteringSyncStatus: null
    },
    privilegedAccess: {
      uacInterceptionEnabled: false,
      activePamRules: 0,
      elevationsInWindow: 0,
      elevationsApproved: 0,
      elevationsDenied: 0,
      mfaStepUpEnforced: false
    },
    securityProducts: [],
    postureScore: null
  } satisfies PostureSummary;
}

function prettyDnsProvider(p: string): string {
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

export async function generateSecurityCompliancePostureReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  perms?: UserPermissions
): Promise<ReportResult> {
  const cfg = securityCompliancePostureConfigSchema.parse(rawConfig ?? {});
  const generatedAt = new Date().toISOString();

  if (perms?.allowedSiteIds && cfg.sites.some((siteId) => !canAccessSite(perms, siteId))) {
    throw new Error('Requested site is outside the caller scope');
  }

  const allowedDeviceIds = await resolveSiteAllowedDeviceIds(orgId, perms);

  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (allowedDeviceIds?.length === 0) {
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: emptySummary(orgRow, generatedAt, cfg.includeCis, cfg.backupRequired)
    };
  }

  const deviceConditions = [eq(devices.orgId, orgId)];
  if (cfg.sites.length > 0) {
    deviceConditions.push(inArray(devices.siteId, cfg.sites));
  }
  if (allowedDeviceIds) {
    deviceConditions.push(inArray(devices.id, allowedDeviceIds));
  }

  const deviceRows = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      osType: devices.osType,
      siteName: sites.name
    })
    .from(devices)
    .leftJoin(sites, eq(devices.siteId, sites.id))
    .where(and(...deviceConditions));

  const deviceIds = deviceRows.map((d) => d.id);
  if (deviceIds.length === 0) {
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: emptySummary(orgRow, generatedAt, cfg.includeCis, cfg.backupRequired)
    };
  }

  const ssRows = await db
    .select({
      deviceId: securityStatus.deviceId,
      provider: securityStatus.provider,
      realTimeProtection: securityStatus.realTimeProtection,
      definitionsDate: securityStatus.definitionsDate,
      encryptionStatus: securityStatus.encryptionStatus,
      firewallEnabled: securityStatus.firewallEnabled,
      passwordPolicySummary: securityStatus.passwordPolicySummary,
      localAdminSummary: securityStatus.localAdminSummary
    })
    .from(securityStatus)
    .where(and(eq(securityStatus.orgId, orgId), inArray(securityStatus.deviceId, deviceIds)));
  const ssByDevice = new Map(ssRows.map((r) => [r.deviceId, r]));

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

  const patchRows = await db
    .select({ deviceId: devicePatches.deviceId, severity: patches.severity })
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
  const windowStart = new Date(Date.now() - cfg.windowDays * 86400000);
  const elevationRows = await db
    .select({ approvedAt: elevationRequests.approvedAt, deniedByUserId: elevationRequests.deniedByUserId })
    .from(elevationRequests)
    .where(and(eq(elevationRequests.orgId, orgId), gte(elevationRequests.requestedAt, windowStart)));
  const elevationsApproved = elevationRows.filter((e) => e.approvedAt != null).length;
  const elevationsDenied = elevationRows.filter((e) => e.deniedByUserId != null).length;

  let mfaStepUpEnforced = false;
  if (orgRow?.partnerId) {
    const [authPol] = await db
      .select({ requireEnrollment: authenticatorPolicies.requireEnrollment, enforceFrom: authenticatorPolicies.enforceFrom })
      .from(authenticatorPolicies)
      .where(eq(authenticatorPolicies.partnerId, orgRow.partnerId))
      .limit(1);
    mfaStepUpEnforced =
      Boolean(authPol?.requireEnrollment) &&
      (!authPol?.enforceFrom || new Date(authPol.enforceFrom).getTime() <= Date.now());
  }

  const [postureRow] = await db
    .select({ overallScore: securityPostureOrgSnapshots.overallScore })
    .from(securityPostureOrgSnapshots)
    .where(eq(securityPostureOrgSnapshots.orgId, orgId))
    .orderBy(desc(securityPostureOrgSnapshots.capturedAt))
    .limit(1);

  // CIS hardening pass-rate per device (latest scan), optional via config.includeCis.
  // Uses the result's aggregate columns directly — no findings-jsonb parsing needed.
  const cisByDevice = new Map<string, number>();
  if (cfg.includeCis) {
    const cisRows = await db
      .select({
        deviceId: cisBaselineResults.deviceId,
        passedChecks: cisBaselineResults.passedChecks,
        totalChecks: cisBaselineResults.totalChecks
      })
      .from(cisBaselineResults)
      .where(and(eq(cisBaselineResults.orgId, orgId), inArray(cisBaselineResults.deviceId, deviceIds)))
      .orderBy(desc(cisBaselineResults.checkedAt));
    for (const r of cisRows) {
      if (cisByDevice.has(r.deviceId)) continue; // desc order → first seen is the latest scan
      cisByDevice.set(r.deviceId, r.totalChecks > 0 ? Math.round((r.passedChecks / r.totalChecks) * 100) : 0);
    }
  }
  const cisValues = [...cisByDevice.values()];
  const cisAvgPassRate =
    cfg.includeCis && cisValues.length > 0
      ? Math.round(cisValues.reduce((a, b) => a + b, 0) / cisValues.length)
      : null;

  // Patch-assessed set: a device counts toward patch currency only if it has at
  // least one device_patches row (any status). Absence of patch data is "unknown",
  // never silently scored as "current". (db.select — selectDistinct isn't mocked.)
  const patchRowDevices = await db
    .select({ deviceId: devicePatches.deviceId })
    .from(devicePatches)
    .where(and(eq(devicePatches.orgId, orgId), inArray(devicePatches.deviceId, deviceIds)));
  const patchScannedDevices = new Set(patchRowDevices.map((r) => r.deviceId));

  let reporting = 0; // devices reporting a security_status row
  let managedEdr = 0;
  let anyAv = 0;
  let unprotected = 0;
  // Each control tracks an "assessed" denominator separate from `reporting`, so a
  // device that reported security_status but lacks data for a given control is an
  // explicit unknown — never folded into pass or fail.
  let encAssessed = 0;
  let encrypted = 0;
  let fwAssessed = 0;
  let firewall = 0;
  let pwAssessed = 0;
  let pwPass = 0;
  let adminAssessed = 0;
  let adminFlagged = 0;
  let patchScanned = 0;
  let patchCurrent = 0;
  let avDefAssessed = 0;
  let avDefCurrent = 0;

  const rows = deviceRows.map((d) => {
    const ss = ssByDevice.get(d.id);
    const managed: string[] = [];
    if (huntressDevices.has(d.id)) managed.push('Huntress');
    if (s1Devices.has(d.id)) managed.push('SentinelOne');
    const isManaged = managed.length > 0;
    const rtp = ss?.realTimeProtection ?? null;
    const hasNativeAv = Boolean(ss && ss.provider && ss.provider !== 'other' && rtp === true);
    const protectedDevice = isManaged || hasNativeAv;

    if (ss) reporting += 1;
    if (isManaged) managedEdr += 1;
    if (isManaged || hasNativeAv) anyAv += 1;
    if (!protectedDevice) unprotected += 1;

    const enc = ss?.encryptionStatus ?? 'unknown';
    if (ss && enc !== 'unknown') {
      encAssessed += 1;
      if (enc === 'encrypted') encrypted += 1;
    }
    if (ss && ss.firewallEnabled != null) {
      fwAssessed += 1;
      if (ss.firewallEnabled === true) firewall += 1;
    }
    if (ss) {
      const pw = passwordComplexityResult(ss.passwordPolicySummary, cfg.minPasswordLength);
      if (pw !== null) {
        pwAssessed += 1;
        if (pw) pwPass += 1;
      }
    }
    const admins = ss ? localAdminCount(ss.localAdminSummary) : null;
    if (ss && admins != null) {
      adminAssessed += 1;
      if (admins > cfg.maxLocalAdmins) adminFlagged += 1;
    }

    const pend = pendingByDevice.get(d.id) ?? { total: 0, critical: 0 };
    if (patchScannedDevices.has(d.id)) {
      patchScanned += 1;
      if (pend.critical === 0) patchCurrent += 1;
    }

    // AV definitions currency honors cfg.maxAvDefinitionsAgeDays, over native-AV
    // devices that report a definitions date (managed-EDR-only devices have none).
    const avAge = ss ? daysAgo(ss.definitionsDate) : null;
    if (hasNativeAv && avAge != null) {
      avDefAssessed += 1;
      if (avAge <= cfg.maxAvDefinitionsAgeDays) avDefCurrent += 1;
    }

    const vuln = vulnByDevice.get(d.id) ?? { critical: 0, high: 0 };

    return {
      hostname: d.hostname,
      site: d.siteName ?? null,
      os: d.osType ?? '',
      protection: ss || isManaged ? protectionLabel({ managed, nativeProvider: ss?.provider ?? null, rtp }) : 'No data',
      protectionManaged: isManaged,
      realTimeProtection: rtp,
      avDefinitionsAgeDays: avAge,
      encryption: ss ? enc : 'no data',
      firewall: ss ? ss.firewallEnabled : null,
      localAdmins: admins,
      patchAssessed: patchScannedDevices.has(d.id),
      pendingPatches: pend.total,
      criticalPatches: pend.critical,
      openVulnCritical: vuln.critical,
      openVulnHigh: vuln.high,
      cisPassRate: cisByDevice.get(d.id) ?? null,
      posture: null
    };
  });

  const deviceCount = deviceRows.length;

  // An integration that exists but is failing to sync is not "active" for the
  // purpose of an attestation. Treat lastSyncStatus 'error' as degraded.
  const dnsSyncStatus = dns?.lastSyncStatus ?? null;
  const dnsActive = Boolean(dns) && dnsSyncStatus !== 'error';

  const productEvidence: SecurityProductEvidence[] = [];
  if (huntressDevices.size > 0) {
    productEvidence.push({
      product: 'Huntress',
      category: 'mdr',
      active: true,
      lastSyncStatus: null,
      deviceIds: huntressDevices
    });
  }
  if (s1Devices.size > 0) {
    productEvidence.push({
      product: 'SentinelOne',
      category: 'edr',
      active: true,
      lastSyncStatus: null,
      deviceIds: s1Devices
    });
  }
  for (const row of ssRows) {
    if (row.provider === 'other') continue;
    productEvidence.push({
      product: prettySecurityProvider(row.provider),
      category: categoryForEndpointProvider(row.provider),
      active: row.realTimeProtection === true,
      lastSyncStatus: null,
      deviceIds: [row.deviceId]
    });
  }
  if (dns) productEvidence.push({ product: prettyDnsProvider(dns.provider), category: 'dns_filtering', active: dnsActive, lastSyncStatus: dnsSyncStatus });
  if (backup) productEvidence.push({ product: `Backup (${backup.provider})`, category: 'backup', active: true, lastSyncStatus: null });
  if (c2c) productEvidence.push({ product: `SaaS backup (${c2c.provider})`, category: 'backup', active: true, lastSyncStatus: null });
  if (m365) productEvidence.push({ product: 'Microsoft 365', category: 'identity', active: true, lastSyncStatus: null });
  if (google) productEvidence.push({ product: 'Google Workspace', category: 'identity', active: true, lastSyncStatus: null });
  const securityProducts = buildSecurityProductInventory(productEvidence);

  const summary = {
      org: { id: orgRow?.id ?? orgId, name: orgRow?.name ?? 'Unknown' },
      generatedAt,
      deviceCount,
      controls: {
        edrCoveragePct: pctOrNull(managedEdr, deviceCount),
        anyAvCoveragePct: pctOrNull(anyAv, deviceCount),
        unprotectedCount: unprotected,
        encryptionPct: pctOrNull(encrypted, encAssessed),
        firewallPct: pctOrNull(firewall, fwAssessed),
        patchCurrentPct: pctOrNull(patchCurrent, patchScanned),
        patchUnknownCount: deviceCount - patchScanned,
        passwordComplexityPct: pctOrNull(pwPass, pwAssessed),
        passwordUnknownCount: reporting - pwAssessed,
        localAdminExposurePct: pctOrNull(adminFlagged, adminAssessed),
        localAdminUnknownCount: reporting - adminAssessed,
        avDefinitionsCurrentPct: pctOrNull(avDefCurrent, avDefAssessed),
        cisAvgPassRate,
        cisIncluded: cfg.includeCis,
        cisAssessedCount: cisByDevice.size,
        // Proves an identity provider is CONNECTED, not that MFA is enforced.
        // Real MFA enforcement is privilegedAccess.mfaStepUpEnforced.
        identityProviderConnected: Boolean(m365 || google),
        backupRequired: cfg.backupRequired,
        backupConfigured: Boolean(backup || c2c),
        backupEncrypted: backup ? Boolean(backup.encryption) : null,
        dnsFilteringActive: dnsActive,
        dnsFilteringSyncStatus: dnsSyncStatus
      },
      privilegedAccess: {
        uacInterceptionEnabled: Boolean(pamCfg?.uacInterceptionEnabled),
        activePamRules: pamRuleRows.length,
        windowDays: cfg.windowDays,
        elevationsInWindow: elevationRows.length,
        elevationsApproved,
        elevationsDenied,
        mfaStepUpEnforced
      },
      securityProducts,
      postureScore: postureRow?.overallScore ?? null
  } satisfies PostureSummary;

  return { rows, rowCount: rows.length, generatedAt, summary };
}
