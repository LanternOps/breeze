import { describe, it, expect, vi, beforeEach } from 'vitest';

const vulnerabilityMocks = vi.hoisted(() => ({
  loadOpenVulnerabilityCounts: vi.fn(),
}));

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./reportGenerationService', () => ({
  resolveSiteAllowedDeviceIds: vi.fn(async () => null)
}));
vi.mock('./securityComplianceReportVulnerabilities', () => vulnerabilityMocks);

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
 *  5 huntress_agents   6 device_patches+severity   7 dns_filter
 *  8 backup_configs   9 c2c_connections   10 m365   11 google
 * 12 pam_org_config   13 pam_rules   14 elevation_requests
 * 15 authenticator_policies (only if org has partnerId)   16 latest org posture snapshot
 * 17 cis_baseline_results (only if includeCis)   18 device_patches scanned-set (any status)
 */
function mockGeneratorQueries(over: Partial<Record<number, any[]>> = {}, opts: { noPartner?: boolean } = {}) {
  const seq: any[][] = [
    /* 1 organizations */      [{ id: ORG, name: 'Acme Co', partnerId: opts.noPartner ? null : 'p1' }],
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
    /* 7 dns_filter */         [{ isActive: true, provider: 'umbrella', lastSyncStatus: 'success' }],
    /* 8 backup_configs */     [{ isActive: true, provider: 's3', encryption: true }],
    /* 9 c2c */                [],
    /* 10 m365 */              [{ status: 'active' }],
    /* 11 google */            [],
    /* 12 pam_org_config */    [{ uacInterceptionEnabled: true }],
    /* 13 pam_rules */         [{ id: 'r1' }, { id: 'r2' }],
    /* 14 elevation_requests*/ [{ approvedAt: new Date(), deniedByUserId: null }, { approvedAt: null, deniedByUserId: 'u1' }],
    /* 15 authenticator */     [{ requireEnrollment: true, enforceFrom: new Date(Date.now() - 86400000) }],
    /* 16 posture snapshot */  [{ overallScore: 82 }]
  ];
  for (const [i, rows] of Object.entries(over)) {
    if (rows) seq[Number(i) - 1] = rows;
  }
  // No-partner orgs skip the authenticator_policies query (#15), so drop that slot
  // to keep the remaining queries aligned with the generator's actual call order.
  if (opts.noPartner) seq.splice(14, 1);
  const m = vi.mocked(db.select);
  m.mockReset();
  // Fill any sparse holes (e.g. overriding #18 without #17) with [] so every
  // queued query resolves to an iterable, not undefined.
  for (let i = 0; i < seq.length; i++) m.mockReturnValueOnce(selectChain(seq[i] ?? []));
  m.mockReturnValue(selectChain([]));
}

describe('generateSecurityCompliancePostureReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vulnerabilityMocks.loadOpenVulnerabilityCounts.mockResolvedValue(
      new Map([
        ['dev-1', { high: 2, critical: 1 }],
        ['dev-2', { high: 1, critical: 0 }],
      ]),
    );
  });

  it('places tenant-safe open vulnerability counts into per-device rows', async () => {
    mockGeneratorQueries();
    const result = await generateSecurityCompliancePostureReport(ORG, {});
    const rows = Object.fromEntries((result.rows as any[]).map((row) => [row.hostname, row]));

    expect(vulnerabilityMocks.loadOpenVulnerabilityCounts).toHaveBeenCalledWith([
      'dev-1',
      'dev-2',
      'dev-3',
    ]);
    expect(rows['pc-1']).toMatchObject({ openVulnHigh: 2, openVulnCritical: 1 });
    expect(rows['pc-2']).toMatchObject({ openVulnHigh: 1, openVulnCritical: 0 });
  });

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

  it('counts an Elastic Defend device with RTP on as AV-covered, not unprotected (#2018)', async () => {
    mockGeneratorQueries({
      // dev-1: Huntress-managed (#5). dev-2: native Elastic Defend with RTP on.
      // dev-3: no security_status row → unprotected.
      3: [
        { deviceId: 'dev-2', provider: 'elastic_defend', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: { minLength: 12, lockoutThreshold: 5 }, localAdminSummary: { adminCount: 1 } }
      ]
    });
    const r = await generateSecurityCompliancePostureReport(ORG, { sites: [] });
    const c = (r.summary as any).controls;
    // Before the fix, elastic_defend normalized to 'other' → dev-2 would be
    // unprotected (anyAv 33%). Recognized as native AV it joins dev-1 in coverage.
    expect(c.anyAvCoveragePct).toBe(67);
    expect(c.unprotectedCount).toBe(1);
    const byHost = Object.fromEntries((r.rows as any[]).map((x) => [x.hostname, x]));
    expect(byHost['pc-2'].protection).toMatch(/Elastic Defend/i);
  });

  it('computes control percentages from security_status', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const c = (r.summary as any).controls;
    expect(c.encryptionPct).toBe(50);
    expect(c.firewallPct).toBe(50);
    expect(c.passwordComplexityPct).toBe(50);
  });

  it('excludes a stale security_status row from firewall/encryption, marking it unknown', async () => {
    const stale = new Date(Date.now() - 60 * 86400000); // 60 days ago
    mockGeneratorQueries({
      2: [
        { id: 'fresh', hostname: 'pc-fresh', osType: 'windows', siteName: 'S' },
        { id: 'stale', hostname: 'pc-stale', osType: 'windows', siteName: 'S' },
      ],
      3: [
        { deviceId: 'fresh', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: { minLength: 12, lockoutThreshold: 5 }, localAdminSummary: { adminCount: 1 }, updatedAt: new Date() },
        { deviceId: 'stale', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'unencrypted', firewallEnabled: false, passwordPolicySummary: { minLength: 4 }, localAdminSummary: { adminCount: 5 }, updatedAt: stale },
      ],
      4: [],
      5: [],
    });
    // Default cutoff is 30 days → the 60-day-old row is excluded from both controls.
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const c = (r.summary as any).controls;
    // Only pc-fresh is assessed: 1/1 encrypted, 1/1 firewall on. The stale
    // 'unencrypted'/firewall-off row does NOT drag the pass rate down.
    expect(c.encryptionPct).toBe(100);
    expect(c.firewallPct).toBe(100);
    // Two in-scope devices, one assessed → one unknown each.
    expect(c.encryptionUnknownCount).toBe(1);
    expect(c.firewallUnknownCount).toBe(1);
    // The stale device's per-row cells read as "no data", matching the aggregate.
    const byHost = Object.fromEntries((r.rows as any[]).map((x) => [x.hostname, x]));
    expect(byHost['pc-stale'].encryption).toBe('no data');
    expect(byHost['pc-stale'].firewall).toBeNull();
  });

  it('honors a custom maxSecurityStatusAgeDays cutoff', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000);
    mockGeneratorQueries({
      2: [{ id: 'd', hostname: 'h', osType: 'windows', siteName: 'S' }],
      3: [
        { deviceId: 'd', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null, updatedAt: tenDaysAgo },
      ],
      4: [],
      5: [],
    });
    // A 10-day-old row is fresh under the 30-day default but stale under a 7-day cutoff.
    const c = (await generateSecurityCompliancePostureReport(ORG, { maxSecurityStatusAgeDays: 7 })).summary!.controls as any;
    expect(c.encryptionPct).toBeNull();
    expect(c.firewallPct).toBeNull();
    expect(c.encryptionUnknownCount).toBe(1);
    expect(c.firewallUnknownCount).toBe(1);
  });

  it('counts a device with no security_status row toward the unknown tally (deviceCount basis)', async () => {
    const stale = new Date(Date.now() - 60 * 86400000);
    mockGeneratorQueries({
      2: [
        { id: 'assessed', hostname: 'pc-a', osType: 'windows', siteName: 'S' },
        { id: 'stale', hostname: 'pc-s', osType: 'windows', siteName: 'S' },
        { id: 'norow', hostname: 'pc-n', osType: 'windows', siteName: 'S' },
      ],
      3: [
        { deviceId: 'assessed', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null, updatedAt: new Date() },
        { deviceId: 'stale', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null, updatedAt: stale },
        // 'norow' intentionally has no security_status row.
      ],
      4: [],
      5: [],
    });
    const c = (await generateSecurityCompliancePostureReport(ORG, {})).summary!.controls as any;
    // 3 in-scope devices, only 'assessed' is fresh with data. Unknown must be 2
    // (stale + no-row). A `reporting - assessed` basis would wrongly yield 1 by
    // dropping the no-row device — this pins the deviceCount denominator.
    expect(c.encryptionPct).toBe(100);
    expect(c.firewallPct).toBe(100);
    expect(c.encryptionUnknownCount).toBe(2);
    expect(c.firewallUnknownCount).toBe(2);
  });

  it('treats a row exactly at the cutoff as fresh and one day past it as stale', async () => {
    mockGeneratorQueries({
      2: [
        { id: 'edge', hostname: 'pc-edge', osType: 'windows', siteName: 'S' },
        { id: 'past', hostname: 'pc-past', osType: 'windows', siteName: 'S' },
      ],
      3: [
        // daysAgo floors to whole days: exactly 30d → 30 (<= 30, fresh); 31d → stale.
        { deviceId: 'edge', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null, updatedAt: new Date(Date.now() - 30 * 86400000) },
        { deviceId: 'past', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null, updatedAt: new Date(Date.now() - 31 * 86400000) },
      ],
      4: [],
      5: [],
    });
    const c = (await generateSecurityCompliancePostureReport(ORG, {})).summary!.controls as any;
    // Only 'edge' (exactly at the inclusive 30-day cutoff) is assessed; 'past' is unknown.
    expect(c.encryptionPct).toBe(100);
    expect(c.firewallPct).toBe(100);
    expect(c.encryptionUnknownCount).toBe(1);
    expect(c.firewallUnknownCount).toBe(1);
  });

  it('fails open: a row with no updatedAt is treated as fresh, not stale', async () => {
    mockGeneratorQueries({
      2: [{ id: 'd', hostname: 'h', osType: 'windows', siteName: 'S' }],
      3: [
        // updatedAt omitted → daysAgo returns null → fail-open as fresh (defensive;
        // the column is NOT NULL in prod, so this documents the intended default).
        { deviceId: 'd', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null },
      ],
      4: [],
      5: [],
    });
    const c = (await generateSecurityCompliancePostureReport(ORG, {})).summary!.controls as any;
    expect(c.encryptionPct).toBe(100);
    expect(c.firewallPct).toBe(100);
    expect(c.encryptionUnknownCount).toBe(0);
    expect(c.firewallUnknownCount).toBe(0);
  });

  it('carries the backup requirement without changing posture score', async () => {
    mockGeneratorQueries();
    const summary = (await generateSecurityCompliancePostureReport(ORG, {
      backupRequired: false,
    })).summary as any;
    expect(summary.controls.backupRequired).toBe(false);
    expect(summary.controls.backupConfigured).toBe(true);
    expect(summary.securityProducts).toContainEqual(
      expect.objectContaining({ category: 'backup' }),
    );
    expect(summary.postureScore).toBe(82);
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
    // CIS is query #17 (after posture); provide latest-scan rows per device.
    mockGeneratorQueries({
      17: [
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
    mockGeneratorQueries(); // patch-scanned (#18) defaults empty → nothing patch-assessed
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
    // #6 pending = dev-2 critical; #18 scanned-set = dev-1 + dev-2 (dev-3 never scanned)
    mockGeneratorQueries({ 18: [{ deviceId: 'dev-1' }, { deviceId: 'dev-2' }] });
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
    mockGeneratorQueries({ 7: [{ isActive: true, provider: 'umbrella', lastSyncStatus: 'error' }] });
    const summary = (await generateSecurityCompliancePostureReport(ORG, {})).summary as any;
    expect(summary.controls.dnsFilteringActive).toBe(false);
    expect(summary.controls.dnsFilteringSyncStatus).toBe('error');
    const dnsProduct = summary.securityProducts.find((p: any) => p.category === 'dns_filtering');
    expect(dnsProduct.active).toBe(false);
  });

  it('reports CIS coverage (assessed count) alongside the average (H4)', async () => {
    mockGeneratorQueries({ 17: [{ deviceId: 'dev-1', passedChecks: 90, totalChecks: 100 }] });
    const c = (await generateSecurityCompliancePostureReport(ORG, {})).summary!.controls as any;
    expect(c.cisAvgPassRate).toBe(90);
    expect(c.cisAssessedCount).toBe(1); // 1 of 3 devices scanned — coverage is visible
  });

  it('counts native-AV-only toward anyAv but not EDR, and SentinelOne as managed', async () => {
    mockGeneratorQueries({
      2: [
        { id: 'a', hostname: 'pc-a', osType: 'windows', siteName: 'S' },
        { id: 'n', hostname: 'pc-n', osType: 'windows', siteName: 'S' }
      ],
      3: [
        { deviceId: 'a', provider: 'sentinelone', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: { minLength: 12, lockoutThreshold: 5 }, localAdminSummary: { adminCount: 1 } },
        { deviceId: 'n', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: { minLength: 12, lockoutThreshold: 5 }, localAdminSummary: { adminCount: 1 } }
      ],
      4: [{ deviceId: 'a' }], // SentinelOne manages pc-a
      5: [] // no Huntress
    });
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const c = (r.summary as any).controls;
    expect(c.edrCoveragePct).toBe(50); // only pc-a is managed
    expect(c.anyAvCoveragePct).toBe(100); // pc-a managed + pc-n native RTP-on
    expect(c.unprotectedCount).toBe(0);
    const byHost = Object.fromEntries((r.rows as any[]).map((x) => [x.hostname, x]));
    expect(byHost['pc-a'].protectionManaged).toBe(true);
    expect(byHost['pc-a'].protection).toMatch(/SentinelOne/);
    expect(byHost['pc-n'].protectionManaged).toBe(false);
    expect(byHost['pc-n'].protection).toMatch(/Defender \(RTP on\)/);
    expect((r.summary as any).securityProducts.map((p: any) => p.product)).toContain('SentinelOne');
  });

  it('excludes provider "other" and real-provider-with-RTP-off from protection', async () => {
    mockGeneratorQueries({
      2: [
        { id: 'o', hostname: 'pc-o', osType: 'windows', siteName: 'S' },
        { id: 'f', hostname: 'pc-f', osType: 'windows', siteName: 'S' }
      ],
      3: [
        { deviceId: 'o', provider: 'other', realTimeProtection: true, definitionsDate: null, encryptionStatus: 'unknown', firewallEnabled: null, passwordPolicySummary: null, localAdminSummary: null },
        { deviceId: 'f', provider: 'crowdstrike', realTimeProtection: false, definitionsDate: new Date(), encryptionStatus: 'unknown', firewallEnabled: null, passwordPolicySummary: null, localAdminSummary: null }
      ],
      4: [],
      5: []
    });
    const c = (await generateSecurityCompliancePostureReport(ORG, {})).summary!.controls as any;
    expect(c.anyAvCoveragePct).toBe(0); // 'other'+RTP-on and real+RTP-off both excluded
    expect(c.unprotectedCount).toBe(2);
  });

  it('handles a no-partner org (authenticator query skipped → MFA step-up false)', async () => {
    mockGeneratorQueries({}, { noPartner: true });
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    // The skipped authenticator query must not misalign downstream results.
    expect((r.summary as any).privilegedAccess.mfaStepUpEnforced).toBe(false);
    expect((r.summary as any).postureScore).toBe(82); // posture query still aligned
    expect((r.summary as any).controls.edrCoveragePct).toBe(33); // unchanged from base fixture
  });

  it('lists active security products', async () => {
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const names = (r.summary as any).securityProducts.map((p: any) => p.product.toLowerCase());
    expect(names).toContain('huntress');
    expect(names.join(' ')).toMatch(/umbrella|dns/);
  });

  it('keeps the unidentified "other" provider off a client-facing inventory', async () => {
    // The base fixture has a provider:'other' row. There is no pretty name for
    // it, so dropping the guard in the generator would ship a green-dotted
    // product literally called "other" on an insurance attestation PDF.
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, {});
    const names = (r.summary as any).securityProducts.map((p: any) => p.product.toLowerCase());
    expect(names).not.toContain('other');
  });

  it('lists native and managed products once with unique scoped coverage', async () => {
    mockGeneratorQueries({
      2: [
        { id: 'dev-1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ' },
        { id: 'dev-2', hostname: 'pc-2', osType: 'windows', siteName: 'HQ' },
        { id: 'dev-3', hostname: 'pc-3', osType: 'windows', siteName: 'Remote' },
        { id: 'dev-4', hostname: 'pc-4', osType: 'windows', siteName: 'Remote' },
        { id: 'dev-5', hostname: 'pc-5', osType: 'windows', siteName: 'HQ' },
        { id: 'dev-6', hostname: 'pc-6', osType: 'windows', siteName: 'Remote' },
      ],
      3: [
        { deviceId: 'dev-1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null },
        { deviceId: 'dev-2', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null },
        { deviceId: 'dev-3', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null },
        { deviceId: 'dev-4', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null },
        { deviceId: 'dev-5', provider: 'sentinelone', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null },
        { deviceId: 'dev-6', provider: 'sentinelone', realTimeProtection: false, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null },
      ],
      4: [{ deviceId: 'dev-5' }, { deviceId: 'dev-6' }],
    });

    const summary = (await generateSecurityCompliancePostureReport(ORG, {})).summary as any;
    expect(summary.securityProducts.filter((p: any) => p.product === 'Defender')).toEqual([
      expect.objectContaining({ category: 'antivirus', deviceCoverage: 4, active: true }),
    ]);
    expect(summary.securityProducts.filter((p: any) => p.product === 'SentinelOne')).toEqual([
      expect.objectContaining({ category: 'edr', deviceCoverage: 2, active: true }),
    ]);
  });

  it('returns empty rows but a valid summary when no devices in scope', async () => {
    const svc = await import('./reportGenerationService');
    vi.mocked(svc.resolveSiteAllowedDeviceIds).mockResolvedValueOnce([]);
    mockGeneratorQueries();
    const r = await generateSecurityCompliancePostureReport(ORG, { backupRequired: false });
    expect(r.rows).toEqual([]);
    expect((r.summary as any).deviceCount).toBe(0);
    expect((r.summary as any).controls.backupRequired).toBe(false);
    // No devices assessed → null ("N/A"), never a misleading 0%.
    expect((r.summary as any).controls.edrCoveragePct).toBeNull();
  });

  it('carries backupRequired when the device query returns no rows', async () => {
    mockGeneratorQueries({ 2: [] });
    const r = await generateSecurityCompliancePostureReport(ORG, { backupRequired: false });
    expect(r.rows).toEqual([]);
    expect((r.summary as any).controls.backupRequired).toBe(false);
  });
});
