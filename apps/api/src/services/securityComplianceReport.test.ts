import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./reportGenerationService', () => ({
  resolveSiteAllowedDeviceIds: vi.fn(async () => null)
}));

import { db } from '../db';
import { generateSecurityCompliancePostureReport } from './securityComplianceReport';

/** Thenable that resolves to `rows` and supports any drizzle chain method. */
function selectChain(rows: any) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) {
    p[m] = () => p;
  }
  return p;
}

const ORG = '00000000-0000-0000-0000-000000000001';

/**
 * The generator issues selects in this fixed order:
 *  1 organizations   2 devices   3 security_status   4 s1_agents
 *  5 huntress_agents   6 device_patches+severity   7 device_vulns
 *  8 dns_filter   9 backup_configs   10 c2c_connections   11 m365
 * 12 google   13 pam_org_config   14 pam_rules   15 elevation_requests
 * 16 authenticator_policies (only if org has partnerId)   17 latest org posture snapshot
 * 18 cis_baseline_results (only if includeCis)   19 device_patches scanned-set (any status)
 */
function mockGeneratorQueries(over: Partial<Record<number, any[]>> = {}) {
  const seq: any[][] = [
    /* 1 organizations */      [{ id: ORG, name: 'Acme Co', partnerId: 'p1' }],
    /* 2 devices */            [
      { id: 'dev-1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ' },
      { id: 'dev-2', hostname: 'pc-2', osType: 'macos', siteName: 'HQ' },
      { id: 'dev-3', hostname: 'pc-3', osType: 'windows', siteName: 'Remote' }
    ],
    /* 3 security_status */    [
      { deviceId: 'dev-1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: { minLength: 12, lockoutThreshold: 5 }, localAdminSummary: { adminCount: 1 } },
      { deviceId: 'dev-2', provider: 'other', realTimeProtection: false, definitionsDate: null, encryptionStatus: 'unencrypted', firewallEnabled: false, passwordPolicySummary: { minLength: 4 }, localAdminSummary: { adminCount: 5 } }
    ],
    /* 4 s1_agents */          [],
    /* 5 huntress_agents */    [{ deviceId: 'dev-1' }],
    /* 6 device_patches */     [{ deviceId: 'dev-2', severity: 'critical' }],
    /* 7 device_vulns */       [{ deviceId: 'dev-1', severity: 'high' }],
    /* 8 dns_filter */         [{ isActive: true, provider: 'umbrella', lastSyncStatus: 'success' }],
    /* 9 backup_configs */     [{ isActive: true, provider: 's3', encryption: true }],
    /* 10 c2c */               [],
    /* 11 m365 */              [{ status: 'active' }],
    /* 12 google */            [],
    /* 13 pam_org_config */    [{ uacInterceptionEnabled: true }],
    /* 14 pam_rules */         [{ id: 'r1' }, { id: 'r2' }],
    /* 15 elevation_requests*/ [{ approvedAt: new Date(), deniedByUserId: null }, { approvedAt: null, deniedByUserId: 'u1' }],
    /* 16 authenticator */     [{ requireEnrollment: true, enforceFrom: new Date(Date.now() - 86400000) }],
    /* 17 posture snapshot */  [{ overallScore: 82 }]
  ];
  for (const [i, rows] of Object.entries(over)) {
    if (rows) seq[Number(i) - 1] = rows;
  }
  const m = vi.mocked(db.select);
  m.mockReset();
  // Fill any sparse holes (e.g. overriding #19 without #18) with [] so every
  // queued query resolves to an iterable, not undefined.
  for (let i = 0; i < seq.length; i++) m.mockReturnValueOnce(selectChain(seq[i] ?? []));
  m.mockReturnValue(selectChain([]));
}

describe('generateSecurityCompliancePostureReport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('merges managed EDR with native AV and flags unprotected devices', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, { sites: [] });

    const byHost = Object.fromEntries((r.rows as any[]).map((x) => [x.hostname, x]));
    expect(byHost['pc-1'].protectionManaged).toBe(true);
    expect(byHost['pc-1'].protection).toMatch(/Huntress/i);
    expect(byHost['pc-2'].protectionManaged).toBe(false);

    expect((r.summary as any).controls.edrCoveragePct).toBe(33);
    expect((r.summary as any).controls.unprotectedCount).toBe(2);
  });

  it('computes control percentages from security_status', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const c = (r.summary as any).controls;
    expect(c.encryptionPct).toBe(50);
    expect(c.firewallPct).toBe(50);
    expect(c.passwordComplexityPct).toBe(50);
  });

  it('summarizes privileged access from PAM tables', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const p = (r.summary as any).privilegedAccess;
    expect(p.uacInterceptionEnabled).toBe(true);
    expect(p.activePamRules).toBe(2);
    expect(p.elevationsApproved).toBe(1);
    expect(p.elevationsDenied).toBe(1);
    expect(p.mfaStepUpEnforced).toBe(true);
  });

  it('renders CIS as null (not 0) when no baseline scans exist', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    expect((r.summary as any).controls.cisAvgPassRate).toBeNull();
    expect((r.summary as any).controls.cisIncluded).toBe(true);
  });

  it('aggregates CIS pass-rate per device when included and scans exist', async () => {
    // CIS is query #18 (after posture); provide latest-scan rows per device.
    mockGeneratorQueries({
      18: [
        { deviceId: 'dev-1', passedChecks: 80, totalChecks: 100 },
        { deviceId: 'dev-2', passedChecks: 60, totalChecks: 100 }
      ]
    });
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    expect((r.summary as any).controls.cisIncluded).toBe(true);
    expect((r.summary as any).controls.cisAvgPassRate).toBe(70); // (80 + 60) / 2
    const byHost = Object.fromEntries((r.rows as any[]).map((x) => [x.hostname, x]));
    expect(byHost['pc-1'].cisPassRate).toBe(80);
    expect(byHost['pc-2'].cisPassRate).toBe(60);
  });

  it('omits CIS entirely when includeCis is false', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, { includeCis: false });
    expect((r.summary as any).controls.cisIncluded).toBe(false);
    expect((r.summary as any).controls.cisAvgPassRate).toBeNull();
    expect((r.rows as any[]).every((row) => row.cisPassRate === null)).toBe(true);
  });

  it('reports identity-connected (not MFA) and AV-definitions currency, with patch unknowns', async () => {
    mockGeneratorQueries(); // patch-scanned (#19) defaults empty → nothing patch-assessed
    const c = (await generateSecurityCompliancePostureReport(ORG, {})).summary!.controls as any;
    // C2: the control says only what's proven — identity connected, NOT MFA enforced.
    expect(c.identityProviderConnected).toBe(true);
    expect(c.mfaIdentityConnected).toBeUndefined();
    // H2: maxAvDefinitionsAgeDays now drives a real control (dev-1 defs are fresh).
    expect(c.avDefinitionsCurrentPct).toBe(100);
    // H1: no device_patches rows → patch currency is "not assessed", all unknown.
    expect(c.patchCurrentPct).toBeNull();
    expect(c.patchUnknownCount).toBe(3);
    // H3: DNS sync status is surfaced.
    expect(c.dnsFilteringSyncStatus).toBe('success');
  });

  it('computes patch currency only over patch-scanned devices (H1)', async () => {
    // #6 pending = dev-2 critical; #19 scanned-set = dev-1 + dev-2 (dev-3 never scanned)
    mockGeneratorQueries({ 19: [{ deviceId: 'dev-1' }, { deviceId: 'dev-2' }] });
    const c = (await generateSecurityCompliancePostureReport(ORG, {})).summary!.controls as any;
    expect(c.patchCurrentPct).toBe(50); // dev-1 current, dev-2 has critical pending
    expect(c.patchUnknownCount).toBe(1); // dev-3 unscanned
  });

  it('treats missing per-device data as explicit unknown, never pass/fail (C1/M1/M2)', async () => {
    mockGeneratorQueries({
      2: [{ id: 'd', hostname: 'h', osType: 'windows', siteName: 'S' }],
      3: [{ deviceId: 'd', provider: 'other', realTimeProtection: false, definitionsDate: null, encryptionStatus: 'unknown', firewallEnabled: null, passwordPolicySummary: null, localAdminSummary: null }],
      4: [],
      5: []
    });
    const c = (await generateSecurityCompliancePostureReport(ORG, {})).summary!.controls as any;
    // assessed denominators are 0 → null ("N/A"), and the unknowns are surfaced.
    expect(c.localAdminExposurePct).toBeNull();
    expect(c.localAdminUnknownCount).toBe(1);
    expect(c.passwordComplexityPct).toBeNull();
    expect(c.passwordUnknownCount).toBe(1);
    expect(c.encryptionPct).toBeNull();
    expect(c.firewallPct).toBeNull();
  });

  it('marks a failing-sync DNS integration as degraded, not active (H3)', async () => {
    mockGeneratorQueries({ 8: [{ isActive: true, provider: 'umbrella', lastSyncStatus: 'error' }] });
    const summary = (await generateSecurityCompliancePostureReport(ORG, {})).summary as any;
    expect(summary.controls.dnsFilteringActive).toBe(false);
    expect(summary.controls.dnsFilteringSyncStatus).toBe('error');
    const dnsProduct = summary.securityProducts.find((p: any) => p.category === 'dns_filtering');
    expect(dnsProduct.active).toBe(false);
  });

  it('reports CIS coverage (assessed count) alongside the average (H4)', async () => {
    mockGeneratorQueries({ 18: [{ deviceId: 'dev-1', passedChecks: 90, totalChecks: 100 }] });
    const c = (await generateSecurityCompliancePostureReport(ORG, {})).summary!.controls as any;
    expect(c.cisAvgPassRate).toBe(90);
    expect(c.cisAssessedCount).toBe(1); // 1 of 3 devices scanned — coverage is visible
  });

  it('lists active security products', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const names = (r.summary as any).securityProducts.map((p: any) => p.product.toLowerCase());
    expect(names).toContain('huntress');
    expect(names.join(' ')).toMatch(/umbrella|dns/);
  });

  it('returns empty rows but a valid summary when no devices in scope', async () => {
    const svc = await import('./reportGenerationService');
    vi.mocked(svc.resolveSiteAllowedDeviceIds).mockResolvedValueOnce([]);
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    expect(r.rows).toEqual([]);
    expect((r.summary as any).deviceCount).toBe(0);
    // No devices assessed → null ("N/A"), never a misleading 0%.
    expect((r.summary as any).controls.edrCoveragePct).toBeNull();
  });
});
