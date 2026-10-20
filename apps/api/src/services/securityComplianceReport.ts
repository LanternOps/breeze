import { securityCompliancePostureConfigSchema } from './reportConfigSchemas';
import type { PostureSummary } from '@breeze/shared';
import {
  assertReportExecutionPreflight,
  type ReportResult,
} from './reportGenerationService';
import type { OrgReportExecutionAuthority } from './siteScope';
import {
  buildSecurityProductInventory,
  prettySecurityProvider,
} from './securityComplianceReportProducts';
import { edrReportEvidenceAllowed } from './portal/edrVisibility';
import { loadPostureEvidence, postureEvidencePolicyFromReportConfig } from './postureEvidence';

const pct = (num: number, denom: number): number =>
  denom === 0 ? 0 : Math.round((num / denom) * 100);

/**
 * Percentage that returns null (not 0) when nothing was assessed, so the PDF can
 * render "N/A — no data" instead of a misleading "0%". Critical for an insurance
 * report: an unmeasured control must never read as a measured failure or pass.
 */
const pctOrNull = (num: number, denom: number): number | null =>
  denom === 0 ? null : Math.round((num / denom) * 100);

/** Build a human label for a device's detected protection products. */
function protectionLabel(opts: {
  managed: string[];
  nativeProvider: string | null;
  rtp: boolean | null;
}): string {
  const parts = [...opts.managed];
  if (opts.nativeProvider && opts.nativeProvider !== 'other' && opts.nativeProvider !== 'unknown') {
    parts.push(prettySecurityProvider(opts.nativeProvider));
  }
  if (parts.length === 0) return 'None detected';
  const rtp = opts.rtp === true ? ' (RTP on)' : opts.rtp === false ? ' (RTP off)' : '';
  return parts.join(' + ') + rtp;
}

function emptySummary(
  orgRow: { id: string; name: string } | undefined,
  generatedAt: string,
  includeCis = true,
  backupRequired = true,
  includeOrgWideEvidence = true,
) {
  return {
    org: { id: orgRow?.id ?? '', name: orgRow?.name ?? 'Unknown' },
    generatedAt,
    deviceCount: 0,
    controls: {
      edrCoveragePct: null,
      edrUnknownCount: 0,
      anyAvCoveragePct: null,
      anyAvUnknownCount: 0,
      unprotectedCount: 0,
      encryptionPct: null,
      encryptionUnknownCount: 0,
      firewallPct: null,
      firewallUnknownCount: 0,
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
      backupRequired,
      ...(includeOrgWideEvidence ? {
        identityProviderConnected: false,
        backupConfigured: false,
        backupEncrypted: null,
        dnsFilteringActive: false,
        dnsFilteringSyncStatus: null,
      } : {}),
    },
    ...(includeOrgWideEvidence ? { privilegedAccess: {
      uacInterceptionEnabled: false,
      activePamRules: 0,
      elevationsInWindow: 0,
      elevationsApproved: 0,
      elevationsDenied: 0,
      mfaStepUpEnforced: false
    } } : {}),
    securityProducts: [],
    ...(includeOrgWideEvidence ? { postureScore: null } : {}),
  } satisfies PostureSummary;
}

export async function generateSecurityCompliancePostureReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  authority: OrgReportExecutionAuthority,
): Promise<ReportResult> {
  const cfg = securityCompliancePostureConfigSchema.parse(rawConfig ?? {});
  const generatedAt = new Date().toISOString();

  assertReportExecutionPreflight(
    orgId,
    cfg,
    authority,
    'security_compliance_posture',
  );
  const restrictedScope = authority.scope.kind === 'restricted'
    ? authority.scope
    : null;
  if (restrictedScope && restrictedScope.siteIds.length === 0) {
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: emptySummary(
        { id: orgId, name: 'Unknown' },
        generatedAt,
        cfg.includeCis,
        cfg.backupRequired,
        false,
      ),
    };
  }

  const evidence = await loadPostureEvidence(
    authority.scope,
    postureEvidencePolicyFromReportConfig(cfg),
    new Date(generatedAt),
    // EDR provider framework (#8166): a portal (customer self-service) run
    // honours the strict portal EDR flag.
    { edrEvidenceAllowed: () => edrReportEvidenceAllowed(orgId, authority) },
  );
  const orgRow = evidence.org ?? undefined;
  const deviceCount = evidence.deviceCount;
  if (deviceCount === 0) {
    return {
      rows: [],
      rowCount: 0,
      generatedAt,
      summary: emptySummary(
        orgRow,
        generatedAt,
        cfg.includeCis,
        cfg.backupRequired,
        authority.scope.kind === 'unrestricted',
      )
    };
  }

  const c = evidence.controls;
  const w = evidence.report.orgWide;
  const elevationsApproved = w ? w.elevationRows.filter((e) => e.approvedAt != null).length : 0;
  const elevationsDenied = w ? w.elevationRows.filter((e) => e.deniedByUserId != null).length : 0;

  const rows = evidence.devices.map((d) => {
    const isManaged = d.managed.length > 0;
    const vuln = evidence.report.vulnByDevice.get(d.id) ?? { critical: 0, high: 0 };
    return {
      hostname: d.hostname,
      site: d.siteName ?? null,
      os: d.osType ?? '',
      protection: d.hasStatusRow || isManaged
        ? protectionLabel({ managed: d.managed, nativeProvider: d.nativeProvider, rtp: d.realTimeProtection })
        : 'No data',
      protectionManaged: isManaged,
      realTimeProtection: d.realTimeProtection,
      avDefinitionsAgeDays: d.avDefinitionsAgeDays,
      encryption: d.statusFresh ? d.encryption : 'no data',
      firewall: d.statusFresh ? d.firewall : null,
      localAdmins: d.localAdmins,
      patchAssessed: d.patchAssessed,
      pendingPatches: d.pendingPatches,
      criticalPatches: d.criticalPatches,
      openVulnCritical: vuln.critical,
      openVulnHigh: vuln.high,
      cisPassRate: d.cisPassRate,
      posture: null
    };
  });

  // An integration that exists but is failing to sync is not "active" for the
  // purpose of an attestation. Treat lastSyncStatus 'error' as degraded.
  const dnsSyncStatus = w?.dns?.lastSyncStatus ?? null;
  const dnsActive = Boolean(w?.dns) && dnsSyncStatus !== 'error';

  const securityProducts = buildSecurityProductInventory(evidence.report.productEvidence);

  const summary = {
      org: { id: orgRow?.id ?? orgId, name: orgRow?.name ?? 'Unknown' },
      generatedAt,
      deviceCount,
      controls: {
        // EDR/AV denominators are the ASSESSED devices (spec §19.7): a device
        // Breeze has no evidence about is an explicit unknown, not a failure.
        edrCoveragePct: pctOrNull(c.edr_coverage.passing, c.edr_coverage.assessed),
        edrUnknownCount: evidence.report.edrUnknown,
        anyAvCoveragePct: pctOrNull(c.endpoint_protection.passing, c.endpoint_protection.assessed),
        anyAvUnknownCount: evidence.report.anyAvUnknown,
        unprotectedCount: evidence.report.unprotected,
        encryptionPct: pctOrNull(c.disk_encryption.passing, c.disk_encryption.assessed),
        encryptionUnknownCount: deviceCount - c.disk_encryption.assessed,
        firewallPct: pctOrNull(c.host_firewall.passing, c.host_firewall.assessed),
        firewallUnknownCount: deviceCount - c.host_firewall.assessed,
        patchCurrentPct: pctOrNull(c.os_patch_currency.passing, c.os_patch_currency.assessed),
        patchUnknownCount: deviceCount - c.os_patch_currency.assessed,
        passwordComplexityPct: pctOrNull(c.password_policy.passing, c.password_policy.assessed),
        passwordUnknownCount: deviceCount - c.password_policy.assessed,
        localAdminExposurePct: pctOrNull(c.least_privilege.assessed - c.least_privilege.passing, c.least_privilege.assessed),
        localAdminUnknownCount: deviceCount - c.least_privilege.assessed,
        avDefinitionsCurrentPct: pctOrNull(c.definitions_current.passing, c.definitions_current.assessed),
        cisAvgPassRate: c.hardening_baseline.aggregatePct,
        cisIncluded: cfg.includeCis,
        cisAssessedCount: evidence.report.cisAssessedCount,
        backupRequired: cfg.backupRequired,
        ...(w ? {
          // Proves an identity provider is CONNECTED, not that MFA is enforced.
          // Real MFA enforcement is privilegedAccess.mfaStepUpEnforced.
          identityProviderConnected: Boolean(w.m365 || w.google),
          // A third party counts once it has at least one fresh successful
          // backup on an in-scope device (#6012).
          backupConfigured: Boolean(w.backup || w.c2c || evidence.report.backupProviders.coveredDeviceCount > 0),
          backupEncrypted: w.backup ? Boolean(w.backup.encryption) : null,
          dnsFilteringActive: dnsActive,
          dnsFilteringSyncStatus: dnsSyncStatus,
        } : {}),
      },
      ...(w ? { privilegedAccess: {
        uacInterceptionEnabled: Boolean(w.pamCfg?.uacInterceptionEnabled),
        activePamRules: w.pamRuleRows.length,
        windowDays: cfg.windowDays,
        elevationsInWindow: w.elevationRows.length,
        elevationsApproved,
        elevationsDenied,
        mfaStepUpEnforced: w.mfaStepUpEnforced
      } } : {}),
      securityProducts,
      ...(w ? { postureScore: w.postureRow?.overallScore ?? null } : {}),
  } satisfies PostureSummary;

  return { rows, rowCount: rows.length, generatedAt, summary };
}
