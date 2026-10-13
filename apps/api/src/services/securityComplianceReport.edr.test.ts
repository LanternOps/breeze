/**
 * EDR provider framework (#8164 A11): the posture report counts a healthy EDR
 * endpoint as managed protection, labelled generically (customer deliverable).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./securityComplianceReportVulnerabilities', () => ({
  loadOpenVulnerabilityCounts: vi.fn(async () => new Map()),
}));
vi.mock('./securityComplianceReportBackupProviders', () => ({
  loadBackupProviderEvidence: vi.fn(async () => ({ evidence: [], coveredDeviceCount: 0 })),
}));
const edrMocks = vi.hoisted(() => ({ loadEdrDeviceCoverage: vi.fn() }));
vi.mock('./securityComplianceReportEdr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./securityComplianceReportEdr')>()),
  ...edrMocks,
}));
vi.mock('./authenticatorPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./authenticatorPolicy')>()),
  loadPartnerPolicy: vi.fn(async () => null),
}));

import { db } from '../db';
import { generateSecurityCompliancePostureReport } from './securityComplianceReport';
import type { OrgReportExecutionAuthority } from './siteScope';

const ORG = '00000000-0000-0000-0000-000000000001';

function selectChain(rows: unknown) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) p[m] = () => p;
  return p;
}

const authority: OrgReportExecutionAuthority = {
  principalKind: 'user',
  scope: { version: 1, kind: 'unrestricted', orgId: ORG },
  principalUserId: '11111111-1111-4111-8111-111111111111',
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: 'f'.repeat(64),
};

/** orgs, devices, security_status, s1, huntress — everything after is []. */
function queue(securityStatus: unknown[] = []) {
  const seq = [
    [{ id: ORG, name: 'Acme', partnerId: null }],
    [
      { id: 'dev-1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ' },
      { id: 'dev-2', hostname: 'pc-2', osType: 'windows', siteName: 'HQ' },
    ],
    securityStatus,
    [],
    [],
  ];
  const m = vi.mocked(db.select);
  m.mockReset();
  for (const rows of seq) m.mockReturnValueOnce(selectChain(rows));
  m.mockReturnValue(selectChain([]));
}

beforeEach(() => {
  vi.clearAllMocks();
  edrMocks.loadEdrDeviceCoverage.mockResolvedValue(new Set());
});

const run = () => generateSecurityCompliancePostureReport(ORG, { includeCis: false }, authority);

describe('posture report: EDR coverage', () => {
  it('asks for EDR coverage of exactly the in-scope devices', async () => {
    queue();
    await run();
    expect(edrMocks.loadEdrDeviceCoverage).toHaveBeenCalledWith(ORG, ['dev-1', 'dev-2']);
  });

  it('a device with only EDR coverage is managed and not reported as unprotected', async () => {
    edrMocks.loadEdrDeviceCoverage.mockResolvedValue(new Set(['dev-1']));
    queue(); // no security_status rows, no S1, no Huntress
    const result = await run();
    const rows = Object.fromEntries((result.rows as any[]).map((r) => [r.hostname, r]));
    expect(rows['pc-1']).toMatchObject({ protectionManaged: true, protection: 'Managed endpoint protection' });
    expect(rows['pc-2']).toMatchObject({ protectionManaged: false, protection: 'No data' });
    const summary = result.summary as any;
    expect(summary.controls.unprotectedCount).toBe(1);
    expect(summary.controls.edrCoveragePct).toBe(50);
    expect(summary.controls.anyAvCoveragePct).toBe(50);
  });

  it('emits generic EDR product evidence, never the vendor name', async () => {
    edrMocks.loadEdrDeviceCoverage.mockResolvedValue(new Set(['dev-1', 'dev-2']));
    queue();
    const summary = (await run()).summary as any;
    expect(summary.securityProducts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        product: 'Managed endpoint protection',
        category: 'edr',
        active: true,
        deviceCoverage: 2,
      }),
    ]));
    expect(JSON.stringify(summary)).not.toMatch(/bitdefender|gravityzone/i);
  });

  it('with no EDR coverage the output carries no EDR product or label', async () => {
    queue();
    const result = await run();
    const summary = result.summary as any;
    expect(summary.securityProducts).toEqual([]);
    expect(summary.controls.edrCoveragePct).toBe(0);
    expect(summary.controls.unprotectedCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain('Managed endpoint protection');
  });

  it('combines with Huntress in the protection label', async () => {
    edrMocks.loadEdrDeviceCoverage.mockResolvedValue(new Set(['dev-1']));
    const m = vi.mocked(db.select);
    m.mockReset();
    m.mockReturnValueOnce(selectChain([{ id: ORG, name: 'Acme', partnerId: null }]));
    m.mockReturnValueOnce(selectChain([{ id: 'dev-1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ' }]));
    m.mockReturnValueOnce(selectChain([]));
    m.mockReturnValueOnce(selectChain([]));
    m.mockReturnValueOnce(selectChain([{ deviceId: 'dev-1' }]));
    m.mockReturnValue(selectChain([]));
    const rows = (await run()).rows as any[];
    expect(rows[0].protection).toBe('Huntress + Managed endpoint protection');
  });
});
