import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./securityComplianceReportVulnerabilities', () => ({ loadOpenVulnerabilityCounts: vi.fn(async () => new Map()) }));
vi.mock('./securityComplianceReportBackupProviders', () => ({ loadBackupProviderEvidence: vi.fn(async () => ({ evidence: [], coveredDeviceCount: 0 })) }));
vi.mock('./authenticatorPolicy', async (orig) => ({ ...(await orig<typeof import('./authenticatorPolicy')>()), loadPartnerPolicy: vi.fn(async () => null) }));

import { db } from '../db';
import { loadPostureEvidence, postureEvidencePolicyFromReportConfig, TRUST_PAGE_EVIDENCE_POLICY } from './postureEvidence';
import { securityCompliancePostureConfigSchema } from './reportConfigSchemas';

function selectChain(rows: unknown) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) p[m] = () => p;
  return p;
}
const ORG = '00000000-0000-0000-0000-000000000001';
const AS_OF = new Date('2026-10-13T12:00:00.000Z');
const recent = new Date('2026-10-13T10:00:00.000Z');

/** Positional sequence 1–14, 16–18 (15 is loadPartnerPolicy, mocked). `edrSlot` inserts the edr_endpoints read after slot 6. */
function mockQueries(over: Partial<Record<number, unknown[]>> = {}, opts: { edrSlot?: unknown[]; cisFindings?: unknown[] } = {}) {
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
  // W3e: with includeCisSafeguards the latest-scan findings read follows the cis read (index 15) directly.
  if (opts.cisFindings) seq.splice(16, 0, opts.cisFindings);
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
    // Org-wide configuration facts carry no fabricated evidence time (spec: snapshot time is not evidence time).
    expect(ev.controls.identity_provider.newestEvidenceAt).toBeNull();
    expect(ev.controls.dns_filtering.newestEvidenceAt).toBeNull();
    expect(ev.controls.privileged_access.newestEvidenceAt).toBeNull();
    expect(ev.controls.disk_encryption.newestEvidenceAt).toBe(recent.toISOString());
    // every device is assessed; d1/d2 checked in 2h ago (inside 24h), d3 never.
    expect(ev.controls.continuous_monitoring).toMatchObject({ eligible: 3, assessed: 3, passing: 2, newestEvidenceAt: recent.toISOString() });
    expect(ev.report.orgWide?.postureRow).toEqual({ overallScore: 82 });
  });

  it('the trust-page policy IS the report default configuration', () => {
    expect(TRUST_PAGE_EVIDENCE_POLICY).toEqual(postureEvidencePolicyFromReportConfig(securityCompliancePostureConfigSchema.parse({})));
  });

  it('a recent check-in alone makes a device assessed for EDR/AV; the 30-day cutoff is inclusive', async () => {
    const DAY = 86400000;
    const atCutoff = new Date(AS_OF.getTime() - 30 * DAY);
    const pastCutoff = new Date(AS_OF.getTime() - 30 * DAY - 1);
    mockQueries({
      2: [
        { id: 'd1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ', lastSeenAt: recent },
        { id: 'in', hostname: 'pc-in', osType: 'windows', siteName: 'HQ', lastSeenAt: atCutoff },
        { id: 'out', hostname: 'pc-out', osType: 'windows', siteName: 'HQ', lastSeenAt: pastCutoff },
      ],
      3: [{ deviceId: 'd1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: recent, encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null, updatedAt: recent }],
      5: [],
    });
    const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    // 'in' has no status/agent row but checked in exactly at the cutoff → assessed, failing.
    // 'out' checked in 1ms past it → unknown.
    expect(ev.controls.edr_coverage).toMatchObject({ eligible: 3, assessed: 2, passing: 0 });
    expect(ev.controls.endpoint_protection).toMatchObject({ eligible: 3, assessed: 2, passing: 1 });
    expect(ev.report.edrUnknown).toBe(1);
    expect(ev.report.anyAvUnknown).toBe(1);
    expect(ev.report.unprotected).toBe(2);
    // Neither is inside the 24h monitoring window.
    expect(ev.controls.continuous_monitoring).toMatchObject({ eligible: 3, assessed: 3, passing: 1 });
  });

  it('a stale security_status row is not assessed for encryption/firewall; EDR/AV assessment then rests on the agent row or check-in', async () => {
    const old = new Date('2026-08-01T00:00:00.000Z');
    mockQueries({ 3: [{ deviceId: 'd1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: null, encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: null, localAdminSummary: null, updatedAt: old }] });
    const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(ev.controls.disk_encryption.assessed).toBe(0);
    expect(ev.controls.endpoint_protection.assessed).toBeGreaterThanOrEqual(1);
    expect(ev.devices.find((d) => d.id === 'd1')?.statusFresh).toBe(false);
  });

  describe('per-device evidence age (spec §19 item 18: every device control)', () => {
    const DAY = 86400000;
    const old = new Date(AS_OF.getTime() - 31 * DAY);
    const atCutoff = new Date(AS_OF.getTime() - 30 * DAY);
    const staleRow = (deviceId: string) => ({ deviceId, provider: 'windows_defender', realTimeProtection: true, definitionsDate: recent, encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: { minLength: 12, lockoutThreshold: 5 }, localAdminSummary: { adminCount: 1 }, updatedAt: old });

    it('a stale status row assesses no status-derived control (password, least privilege, definitions, EDR/AV on its own)', async () => {
      mockQueries({
        2: [{ id: 'd1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ', lastSeenAt: null }],
        3: [staleRow('d1')], 5: [], 6: [], 16: [], 17: [],
      });
      const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
      for (const id of ['password_policy', 'least_privilege', 'definitions_current', 'disk_encryption', 'host_firewall', 'edr_coverage', 'endpoint_protection'] as const) {
        expect(ev.controls[id], id).toMatchObject({ eligible: 1, assessed: 0, passing: 0 });
      }
      expect(ev.report.edrUnknown).toBe(1);
      expect(ev.report.anyAvUnknown).toBe(1);
    });

    it('a status row exactly at the cutoff day is still fresh for every status-derived control', async () => {
      mockQueries({
        2: [{ id: 'd1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ', lastSeenAt: null }],
        3: [{ ...staleRow('d1'), updatedAt: atCutoff }], 5: [], 6: [], 16: [], 17: [],
      });
      const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
      for (const id of ['password_policy', 'least_privilege', 'definitions_current', 'edr_coverage', 'endpoint_protection'] as const) {
        expect(ev.controls[id].assessed, id).toBe(1);
      }
    });

    it('an invalid status-row timestamp counts as stale', async () => {
      mockQueries({
        2: [{ id: 'd1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ', lastSeenAt: null }],
        3: [{ ...staleRow('d1'), updatedAt: new Date('not a date') }], 5: [], 6: [], 16: [], 17: [],
      });
      const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
      expect(ev.controls.password_policy.assessed).toBe(0);
      expect(ev.controls.edr_coverage.assessed).toBe(0);
    });

    it('patch currency is assessed only from device_patches evidence inside the window (max of updatedAt / lastCheckedAt)', async () => {
      mockQueries({
        2: [
          { id: 'fresh-check', hostname: 'a', osType: 'windows', siteName: 'HQ', lastSeenAt: recent },
          { id: 'stale', hostname: 'b', osType: 'windows', siteName: 'HQ', lastSeenAt: recent },
          { id: 'fresh-upd', hostname: 'c', osType: 'windows', siteName: 'HQ', lastSeenAt: recent },
        ],
        // mockQueries keys past 14 are shifted by the mocked slot 15: key 16 = cis (17), key 17 = patch set (18).
        3: [], 5: [], 6: [{ deviceId: 'fresh-check', severity: 'critical' }], 16: [],
        17: [
          { deviceId: 'fresh-check', updatedAt: old, lastCheckedAt: recent },
          { deviceId: 'stale', updatedAt: old, lastCheckedAt: old },
          { deviceId: 'stale', updatedAt: old, lastCheckedAt: null },
          { deviceId: 'fresh-upd', updatedAt: recent, lastCheckedAt: null },
        ],
      });
      const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
      expect(ev.controls.os_patch_currency).toMatchObject({ eligible: 3, assessed: 2, passing: 1, newestEvidenceAt: recent.toISOString() });
      expect(ev.devices.find((d) => d.id === 'stale')?.patchAssessed).toBe(false);
    });

    it('a CIS scan older than the window is not assessed and leaves the aggregate out', async () => {
      mockQueries({
        3: [], 5: [], 6: [],
        16: [{ deviceId: 'd1', passedChecks: 9, totalChecks: 10, checkedAt: old }, { deviceId: 'd2', passedChecks: 5, totalChecks: 10, checkedAt: recent }],
      });
      const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
      expect(ev.controls.hardening_baseline).toMatchObject({ eligible: 3, assessed: 1, aggregatePct: 50 });
      expect(ev.report.cisAssessedCount).toBe(1);
      expect(ev.devices.find((d) => d.id === 'd1')?.cisPassRate).toBeNull();
    });
  });

  it('restricted scope omits org-wide evidence and filters devices by site', async () => {
    const ev = await loadPostureEvidence({ version: 1, kind: 'restricted', orgId: ORG, siteIds: ['site-a'] }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(ev.report.orgWide).toBeNull();
    expect(ev.controls.identity_provider).toMatchObject({ eligible: 0, assessed: 0 });
  });

  it('net-new readers (queries 19–21): empty → both controls zero; a rollup row populates mfa_registered_m365 (unrestricted only)', async () => {
    const empty = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(empty.controls.mfa_registered_m365).toMatchObject({ eligible: 0, assessed: 0, passing: 0 });
    expect(empty.controls.backups_verified).toMatchObject({ eligible: 0, assessed: 0, passing: 0 });

    mockQueries({ 18: [{ usersTotal: 10, usersMfaRegistered: 9, usersMfaUnknown: 0, adminsWithoutMfa: 0, computedAt: recent }] });
    const withRollup = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(withRollup.controls.mfa_registered_m365).toMatchObject({ eligible: 10, assessed: 10, passing: 9, gate: true });

    mockQueries({ 18: [{ usersTotal: 10, usersMfaRegistered: 9, usersMfaUnknown: 0, adminsWithoutMfa: 0, computedAt: recent }] });
    const restricted = await loadPostureEvidence({ version: 1, kind: 'restricted', orgId: ORG, siteIds: ['site-a'] }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(restricted.controls.mfa_registered_m365).toMatchObject({ eligible: 0, assessed: 0, passing: 0 });
  });

  it('zero devices → every device control zero, org-wide still loaded', async () => {
    // No device reads (3–6, 17, 18) run for zero devices: the org-wide reads follow slot 2 directly.
    mockQueries({ 2: [], 3: [{ isActive: true, provider: 'umbrella', lastSyncStatus: 'success' }], 4: [{ isActive: true, provider: 's3', encryption: true }], 5: [], 6: [{ status: 'active' }], 7: [], 8: [{ uacInterceptionEnabled: true }], 9: [{ id: 'r1' }], 10: [], 11: [{ overallScore: 82 }] });
    const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(12); // +1: the M365 MFA rollup read (unrestricted only)
    expect(ev.deviceCount).toBe(0);
    expect(ev.controls.disk_encryption).toMatchObject({ eligible: 0, assessed: 0, passing: 0 });
    expect(ev.controls.identity_provider).toMatchObject({ eligible: 1, assessed: 1, passing: 1 });
    expect(ev.controls.dns_filtering).toMatchObject({ eligible: 1, assessed: 1, passing: 1 });
    expect(ev.controls.identity_provider.newestEvidenceAt).toBeNull();
    expect(ev.controls.dns_filtering.newestEvidenceAt).toBeNull();
    expect(ev.controls.privileged_access.newestEvidenceAt).toBeNull();
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
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(19); // +2: M365 rollup + backup_jobs device set
    });

    it('a callback returning false reads no EDR evidence either', async () => {
      const allowed = vi.fn(async () => false);
      await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF, { edrEvidenceAllowed: allowed });
      expect(allowed).toHaveBeenCalledTimes(1);
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(19); // +2: M365 rollup + backup_jobs device set
    });

    it('with the callback allowing it, a healthy endpoint counts the device as managed and protected', async () => {
      mockQueries({}, { edrSlot: [{ deviceId: 'd3' }] });
      const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF, { edrEvidenceAllowed: async () => true });
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(20); // +2: M365 rollup + backup_jobs device set
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

  describe('per-safeguard hardening evidence (W3e)', () => {
    const withSafeguards = { ...TRUST_PAGE_EVIDENCE_POLICY, includeCisSafeguards: true };
    const scan = (deviceId: string, over: Record<string, unknown> = {}) => ({ id: `scan-${deviceId}`, deviceId, passedChecks: 9, totalChecks: 10, checkedAt: recent, ...over });
    const f = (checkId: string, status: string) => ({ checkId, title: `Ensure '${checkId}' verbatim recommendation text`, severity: 'medium', status });
    const run = async (cisRows: unknown[], findingRows: unknown[], policy = withSafeguards) => {
      mockQueries({ 16: cisRows }, { cisFindings: findingRows });
      return loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, policy, AS_OF);
    };

    it('counts eligible/assessed/passing per safeguard from the latest fresh scan', async () => {
      const ev = await run([scan('d1')], [{ deviceId: 'd1', findings: [f('9.1.1', 'pass'), f('2.3.1', 'fail')] }]);
      const sg = ev.controls.hardening_baseline.safeguards!;
      // 4.5 is mapped on windows (9.1.1) and macos (5.1.1): all 3 eligible devices could evidence it; only d1 has.
      expect(sg['4.5']).toEqual({ eligible: 3, assessed: 1, passing: 1, newestEvidenceAt: recent.toISOString() });
      // 4.7 is windows-only: d1 + d3 eligible, the macOS d2 is not.
      expect(sg['4.7']).toEqual({ eligible: 2, assessed: 1, passing: 0, newestEvidenceAt: recent.toISOString() });
    });

    it('a macOS device does not become eligible for a Windows-only safeguard', async () => {
      const ev = await run([], []);
      const sg = ev.controls.hardening_baseline.safeguards!;
      expect(sg['8.5']).toMatchObject({ eligible: 2, assessed: 0, passing: 0 }); // d1 + d3 (windows); d2 (macos) excluded
      expect(sg['3.6']).toMatchObject({ eligible: 1 }); // FileVault: macos only → d2
    });

    it('a device passes a safeguard only when every mapped check with a result passes', async () => {
      const both = await run([scan('d1')], [{ deviceId: 'd1', findings: [f('1.1.1', 'pass'), f('1.1.2', 'pass')] }]);
      expect(both.controls.hardening_baseline.safeguards!['5.2']).toMatchObject({ assessed: 1, passing: 1 });
      const one = await run([scan('d1')], [{ deviceId: 'd1', findings: [f('1.1.1', 'pass'), f('1.1.2', 'fail')] }]);
      expect(one.controls.hardening_baseline.safeguards!['5.2']).toMatchObject({ assessed: 1, passing: 0 });
    });

    it('not_applicable and error findings do not assess a safeguard', async () => {
      const ev = await run([scan('d1')], [{ deviceId: 'd1', findings: [f('9.1.1', 'not_applicable'), f('2.3.1', 'error')] }]);
      const sg = ev.controls.hardening_baseline.safeguards!;
      expect(sg['4.5']).toMatchObject({ assessed: 0, passing: 0, newestEvidenceAt: null });
      expect(sg['4.7']).toMatchObject({ assessed: 0, passing: 0, newestEvidenceAt: null });
    });

    it('a stale latest scan contributes nothing and its findings are not read', async () => {
      const old = new Date(AS_OF.getTime() - 31 * 86400000);
      mockQueries({ 16: [scan('d1', { checkedAt: old })] }); // no findings slot: a stale scan must not trigger the read
      const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, withSafeguards, AS_OF);
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(19);
      expect(ev.controls.hardening_baseline.safeguards!['4.5']).toMatchObject({ assessed: 0, passing: 0 });
    });

    it('a check the mapping does not know assesses nothing; extra/odd non-key fields do not invalidate a finding', async () => {
      const odd = { checkId: '9.1.1', status: 'pass', severity: 'new-level', title: undefined };
      const ev = await run([scan('d1')], [{ deviceId: 'd1', findings: [f('99.9.9', 'pass'), f('2.3.7', 'pass'), odd] }]);
      const sg = ev.controls.hardening_baseline.safeguards!;
      expect(sg['4.5']).toMatchObject({ assessed: 1, passing: 1 });
      expect(sg['4.7']).toMatchObject({ assessed: 0 });
    });

    it('any unreadable finding leaves the device unassessed for every safeguard (a dropped fail must not read as a pass)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ev = await run([scan('d1')], [{ deviceId: 'd1', findings: [f('9.1.1', 'pass'), { checkId: 5 }, f('2.3.1', 'fail')] }]);
      const sg = ev.controls.hardening_baseline.safeguards!;
      expect(sg['4.5']).toMatchObject({ assessed: 0, passing: 0 });
      expect(sg['4.7']).toMatchObject({ assessed: 0, passing: 0 });
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it('includeCisSafeguards = false issues no findings query and leaves safeguards undefined', async () => {
      mockQueries();
      const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(19); // unchanged from the no-safeguards baseline above
      expect(ev.controls.hardening_baseline.safeguards).toBeUndefined();
    });

    it('with the flag on but includeCis off nothing is read or reported', async () => {
      mockQueries();
      const ev = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, { ...withSafeguards, includeCis: false }, AS_OF);
      expect(ev.controls.hardening_baseline.safeguards).toBeUndefined();
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(18); // no cis read, no findings read
    });

    it('the loader reads the live getter when handed TRUST_PAGE_EVIDENCE_POLICY itself (no spread freezing it)', async () => {
      const prev = process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW;
      try {
        process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = 'true';
        mockQueries({ 16: [scan('d1')] }, { cisFindings: [{ deviceId: 'd1', findings: [f('9.1.1', 'pass')] }] });
        const on = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
        expect(on.controls.hardening_baseline.safeguards?.['4.5']).toMatchObject({ assessed: 1, passing: 1 });
        process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = 'false';
        mockQueries();
        const off = await loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId: ORG }, TRUST_PAGE_EVIDENCE_POLICY, AS_OF);
        expect(off.controls.hardening_baseline.safeguards).toBeUndefined();
      } finally {
        if (prev === undefined) delete process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW; else process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = prev;
      }
    });

    it('the report path leaves the flag off; the trust policy follows the CIS gate at call time', () => {
      expect(postureEvidencePolicyFromReportConfig(securityCompliancePostureConfigSchema.parse({})).includeCisSafeguards).toBe(false);
      const prev = process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW;
      try {
        process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = 'true';
        expect(TRUST_PAGE_EVIDENCE_POLICY.includeCisSafeguards).toBe(true);
        process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = 'false';
        expect(TRUST_PAGE_EVIDENCE_POLICY.includeCisSafeguards).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW; else process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = prev;
      }
    });
  });
});
