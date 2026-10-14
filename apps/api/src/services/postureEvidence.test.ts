import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./securityComplianceReportVulnerabilities', () => ({ loadOpenVulnerabilityCounts: vi.fn(async () => new Map()) }));
vi.mock('./securityComplianceReportBackupProviders', () => ({ loadBackupProviderEvidence: vi.fn(async () => ({ evidence: [], coveredDeviceCount: 0 })) }));
vi.mock('./authenticatorPolicy', async (orig) => ({ ...(await orig<typeof import('./authenticatorPolicy')>()), loadPartnerPolicy: vi.fn(async () => null) }));

import { db } from '../db';
import { loadPostureEvidence, TRUST_PAGE_EVIDENCE_POLICY } from './postureEvidence';

function selectChain(rows: unknown) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) p[m] = () => p;
  return p;
}
const ORG = '00000000-0000-0000-0000-000000000001';
const AS_OF = new Date('2026-10-13T12:00:00.000Z');
const recent = new Date('2026-10-13T10:00:00.000Z');

/** Positional sequence 1–14, 16–18 (15 is loadPartnerPolicy, mocked). `edrSlot` inserts the edr_endpoints read after slot 6. */
function mockQueries(over: Partial<Record<number, unknown[]>> = {}, opts: { edrSlot?: unknown[] } = {}) {
  const seq: unknown[][] = [
    /* 1 */ [{ id: ORG, name: 'Acme', partnerId: 'p1' }],
    /* 2 */ [
      { id: 'd1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ', lastSeenAt: recent },
      { id: 'd2', hostname: 'pc-2', osType: 'macos', siteName: 'HQ', lastSeenAt: recent },
      { id: 'd3', hostname: 'pc-3', osType: 'windows', siteName: 'Remote', lastSeenAt: null },
    ],
    /* 3 */ [
      { deviceId: 'd1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: recent, encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: { minLength: 12, lockoutThreshold: 5 }, localAdminSummary: { adminCount: 1 }, updatedAt: recent },
      { deviceId: 'd2', provider: 'other', realTimeProtection: false, definitionsDate: null, encryptionStatus: 'unencrypted', firewallEnabled: false, passwordPolicySummary: { minLength: 4 }, localAdminSummary: { adminCount: 5 }, updatedAt: recent },
    ],
    /* 4 */ [], /* 5 */ [{ deviceId: 'd1' }], /* 6 */ [{ deviceId: 'd2', severity: 'critical' }],
    /* 7 */ [{ isActive: true, provider: 'umbrella', lastSyncStatus: 'success' }],
    /* 8 */ [{ isActive: true, provider: 's3', encryption: true }], /* 9 */ [], /* 10 */ [{ status: 'active' }], /* 11 */ [],
    /* 12 */ [{ uacInterceptionEnabled: true }], /* 13 */ [{ id: 'r1' }], /* 14 */ [],
    /* 16 */ [{ overallScore: 82 }],
    /* 17 */ [{ deviceId: 'd1', passedChecks: 9, totalChecks: 10 }],
    /* 18 */ [{ deviceId: 'd1' }, { deviceId: 'd2' }],
  ];
  for (const [i, rows] of Object.entries(over)) if (rows) seq[Number(i) - 1] = rows;
  if (opts.edrSlot) seq.splice(6, 0, opts.edrSlot);
  const m = vi.mocked(db.select); m.mockReset();
  for (const rows of seq) m.mockReturnValueOnce(selectChain(rows));
  m.mockReturnValue(selectChain([]));
}

describe('loadPostureEvidence', () => {
  beforeEach(() => mockQueries());

  it('counts eligible/assessed/passing per control from the same facts the report uses', async () => {
    const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(ev.deviceCount).toBe(3);
    // d3 has no status row, no agent, no check-in → not assessed for EDR/AV
    expect(ev.controls.edr_coverage).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.controls.endpoint_protection).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.report.edrUnknown).toBe(1);
    expect(ev.report.anyAvUnknown).toBe(1);
    expect(ev.report.unprotected).toBe(2);
    expect(ev.report.reporting).toBe(2);
    expect(ev.controls.disk_encryption).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.controls.host_firewall).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.controls.password_policy).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.controls.least_privilege).toMatchObject({ eligible: 3, assessed: 2, passing: 1 }); // d2 flagged (5 > 2)
    expect(ev.controls.os_patch_currency).toMatchObject({ eligible: 3, assessed: 2, passing: 1 }); // d2 has a pending critical
    expect(ev.controls.definitions_current).toMatchObject({ eligible: 3, assessed: 1, passing: 1 });
    expect(ev.controls.hardening_baseline).toMatchObject({ eligible: 3, assessed: 1, aggregatePct: 90 });
    expect(ev.controls.identity_provider).toMatchObject({ eligible: 1, assessed: 1, passing: 1 });
    expect(ev.controls.dns_filtering).toMatchObject({ eligible: 1, assessed: 1, passing: 1 });
    expect(ev.controls.privileged_access).toMatchObject({ eligible: 1, assessed: 1, passing: 1 });
    expect(ev.controls.disk_encryption.newestEvidenceAt).toBe(recent.toISOString());
    expect(ev.report.orgWide?.postureRow).toEqual({ overallScore: 82 });
  });

  it('a stale security_status row is not assessed for encryption/firewall but still counts as EDR evidence', async () => {
    const old = new Date('2026-08-01T00:00:00.000Z');
    mockQueries({ 3: [{ deviceId: 'd1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: null, encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null, updatedAt: old }] });
    const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(ev.controls.disk_encryption.assessed).toBe(0);
    expect(ev.controls.endpoint_protection.assessed).toBeGreaterThanOrEqual(1);
    expect(ev.devices.find((d) => d.id === 'd1')?.statusFresh).toBe(false);
  });

  it('restricted scope omits org-wide evidence and filters devices by site', async () => {
    const ev = await loadPostureEvidence({ version: 1, kind: 'restricted', orgId: ORG, siteIds: ['site-a'] }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(ev.report.orgWide).toBeNull();
    expect(ev.controls.identity_provider).toMatchObject({ eligible: 0, assessed: 0 });
  });

  it('zero devices → every device control zero, org-wide still loaded', async () => {
    // No device reads (3–6, 17, 18) run for zero devices: the org-wide reads follow slot 2 directly.
    mockQueries({ 2: [], 3: [{ isActive: true, provider: 'umbrella', lastSyncStatus: 'success' }], 4: [{ isActive: true, provider: 's3', encryption: true }], 5: [], 6: [{ status: 'active' }], 7: [], 8: [{ uacInterceptionEnabled: true }], 9: [{ id: 'r1' }], 10: [], 11: [{ overallScore: 82 }] });
    const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(11);
    expect(ev.deviceCount).toBe(0);
    expect(ev.controls.disk_encryption).toMatchObject({ eligible: 0, assessed: 0, passing: 0 });
    expect(ev.controls.identity_provider).toMatchObject({ eligible: 1, assessed: 1, passing: 1 });
    expect(ev.controls.dns_filtering).toMatchObject({ eligible: 1, assessed: 1, passing: 1 });
    expect(ev.report.orgWide?.postureRow).toEqual({ overallScore: 82 });
  });

  it('provider "unknown" (failed collection, #8565) is neither native AV nor a listed product', async () => {
    mockQueries({ 3: [{ deviceId: 'd3', provider: 'unknown', realTimeProtection: true, definitionsDate: recent, encryptionStatus: 'unknown', firewallEnabled: null, passwordPolicySummary: null, localAdminSummary: null, updatedAt: recent }] });
    const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(ev.controls.definitions_current.assessed).toBe(0);
    expect(ev.report.productEvidence.map((p) => p.product.toLowerCase())).not.toContain('unknown');
  });

  describe('EDR-framework evidence (#8166)', () => {
    it('without the callback no edr_endpoints query is issued', async () => {
      await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
      // 1–14, 16, 17, 18 — exactly the 17 positional reads, nothing between slots 6 and 7.
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(17);
    });

    it('a callback returning false reads no EDR evidence either', async () => {
      const allowed = vi.fn(async () => false);
      await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF, { edrEvidenceAllowed: allowed });
      expect(allowed).toHaveBeenCalledTimes(1);
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(17);
    });

    it('with the callback allowing it, a healthy endpoint counts the device as managed and protected', async () => {
      mockQueries({}, { edrSlot: [{ deviceId: 'd3' }] });
      const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF, { edrEvidenceAllowed: async () => true });
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(18);
      const d3 = ev.devices.find((d) => d.id === 'd3')!;
      expect(d3.managed).toEqual(['Managed endpoint protection']);
      expect(d3.protection).toBe('protected');
      expect(ev.controls.edr_coverage).toMatchObject({ eligible: 3, assessed: 3, passing: 2 });
      expect(ev.controls.endpoint_protection).toMatchObject({ eligible: 3, assessed: 3, passing: 2 });
      expect(ev.report.unprotected).toBe(1);
      expect(ev.report.productEvidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ product: 'Managed endpoint protection', category: 'edr' }),
      ]));
      // org-wide reads stay aligned after the extra slot
      expect(ev.report.orgWide?.postureRow).toEqual({ overallScore: 82 });
    });
  });
});
