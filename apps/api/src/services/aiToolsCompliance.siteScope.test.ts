import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('../jobs/softwareRemediationWorker', () => ({ scheduleSoftwareRemediation: vi.fn(async () => 1) }));
vi.mock('./softwarePolicyService', () => ({ normalizeSoftwarePolicyRules: vi.fn((r: any) => r) }));

import { db } from '../db';
import { scheduleSoftwareRemediation } from '../jobs/softwareRemediationWorker';
import { registerComplianceTools } from './aiToolsCompliance';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerComplianceTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds, canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}
function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols && typeof cols === 'object' &&
    'id' in (cols as object) && 'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}
/** Generic chainable query mock that resolves to `result`. */
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset']) {
    p[m] = () => p;
  }
  return p;
}

describe('get_software_compliance — site narrowing (cross-site enumeration)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive compliance rows for a device in a forbidden site', async () => {
    let complianceScanRan = false;
    const forbiddenRow = {
      compliance: { policyId: 'p1', deviceId: 'd-siteB', status: 'violation', violations: [], lastChecked: null, remediationStatus: null },
      policy: { id: 'p1', name: 'Policy', mode: 'blocklist' },
      device: { id: 'd-siteB', hostname: 'forbidden-host' },
    };
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      complianceScanRan = true;
      return chain([forbiddenRow]);
    });

    const r = await handlerFor('get_software_compliance')({}, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.count).toBe(0);
    expect(parsed.compliance).toEqual([]);
    expect(complianceScanRan).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('forbidden-host');
  });

  it('unrestricted caller enumerates compliance normally (no regression)', async () => {
    mockDb.select.mockImplementation(() => chain([
      {
        compliance: { policyId: 'p1', deviceId: 'd1', status: 'compliant', violations: [], lastChecked: null, remediationStatus: null },
        policy: { id: 'p1', name: 'Policy', mode: 'blocklist' },
        device: { id: 'd1', hostname: 'h1' },
      },
    ]));
    const r = await handlerFor('get_software_compliance')({}, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.count).toBe(1);
  });
});

describe('get_compliance_status — site narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller does NOT receive compliance records for a device in a forbidden site', async () => {
    let statusScanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      statusScanRan = true;
      return chain([{ policyId: 'pol-1', deviceId: 'd-siteB', status: 'non_compliant' }]);
    });

    const r = await handlerFor('get_compliance_status')({ policyId: 'pol-1' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.records).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.showing).toBe(0);
    expect(parsed.breakdown).toEqual({});
    expect(statusScanRan).toBe(false);
  });

  it('unrestricted caller reads compliance status normally (no regression)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols && typeof cols === 'object' && 'count' in (cols as object) && 'status' in (cols as object)) {
        return chain([{ status: 'compliant', count: 1 }]); // breakdown
      }
      if (cols && typeof cols === 'object' && 'count' in (cols as object)) {
        return chain([{ count: 1 }]); // total
      }
      return chain([{ policyId: 'pol-1', deviceId: 'd1', status: 'compliant', details: null, lastCheckedAt: null, remediationAttempts: 0 }]);
    });
    const r = await handlerFor('get_compliance_status')({ policyId: 'pol-1' }, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.showing).toBe(1);
    expect(parsed.total).toBe(1);
    expect(parsed.breakdown).toEqual({ compliant: 1 });
  });
});

describe('remediate_software_violation — site narrowing of the org-wide fallback enumeration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('site-restricted caller with no in-scope devices queues NO remediation', async () => {
    let violationScanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      if (cols === undefined) {
        // policy lookup: db.select().from(softwarePolicies)...
        return chain([{ id: 'pol-1', name: 'Policy', mode: 'blocklist' }]);
      }
      violationScanRan = true; // org-wide violation enumeration must not run
      return chain([{ deviceId: 'd-siteB' }]);
    });

    const r = await handlerFor('remediate_software_violation')({ policyId: 'pol-1' }, makeAuth(['site-A']));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.queued).toBe(0);
    expect(violationScanRan).toBe(false);
    expect(scheduleSoftwareRemediation).not.toHaveBeenCalled();
  });

  it('unrestricted caller remediates via the fallback enumeration normally (no regression)', async () => {
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (cols === undefined) {
        return chain([{ id: 'pol-1', name: 'Policy', mode: 'blocklist' }]);
      }
      return chain([{ deviceId: 'd1' }]);
    });
    const r = await handlerFor('remediate_software_violation')({ policyId: 'pol-1' }, makeAuth(undefined));
    const parsed = JSON.parse(r);
    expect(parsed.error).toBeUndefined();
    expect(parsed.queued).toBe(1);
    expect(scheduleSoftwareRemediation).toHaveBeenCalledWith('pol-1', ['d1']);
  });
});
