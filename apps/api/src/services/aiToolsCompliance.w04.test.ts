import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('../jobs/softwareRemediationWorker', () => ({
  scheduleSoftwareRemediation: vi.fn(async (_p: string, ids: string[]) => ids.length),
}));
vi.mock('./softwarePolicyService', async (orig) => {
  const actual = await orig<typeof import('./softwarePolicyService')>();
  return {
    normalizeSoftwarePolicyRules: vi.fn((r: any) => r),
    evaluateSoftwarePolicyArming: actual.evaluateSoftwarePolicyArming,
    recordSoftwarePolicyAudit: vi.fn(async () => {}),
  };
});
vi.mock('./aiToolsSoftwarePolicyAudit', () => ({
  auditSoftwarePolicyToolEvent: vi.fn(),
  summarizeEnforcementChange: vi.fn(() => ({})),
  remediationOptionsArmsAutoInstall: vi.fn(() => false),
  AI_AUTO_INSTALL_REFUSAL_MESSAGE: 'x',
}));

import { db } from '../db';
import { scheduleSoftwareRemediation } from '../jobs/softwareRemediationWorker';
import { MAX_REMEDIATION_DEVICES } from './softwarePolicyRemediationPreview';
import { registerComplianceTools } from './aiToolsCompliance';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerComplianceTools(reg);
  return reg.get(name)!.handler;
}
const auth = {
  user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
  token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
  accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
  canAccessSite: () => true,
} as unknown as AuthContext;
const POLICY = {
  id: 'pol-1', name: 'P', mode: 'blocklist', orgId: 'org-1', partnerId: null,
  enforceMode: true, remediationOptions: { autoUninstall: true },
};
function chain(result: unknown, onLimit?: (n: number) => void): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'groupBy', 'offset']) p[m] = () => p;
  p.limit = (n: number) => { onLimit?.(n); return p; };
  return p;
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);

describe('remediate_software_violation — device cap (W04-D14)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses an explicit deviceIds list over the cap and schedules nothing', async () => {
    mockDb.select.mockImplementation(() => chain([POLICY]));
    const result = JSON.parse(await handlerFor('remediate_software_violation')({
      policyId: 'pol-1', deviceIds: ids(MAX_REMEDIATION_DEVICES + 1),
    }, auth));
    expect(result.error).toMatch(String(MAX_REMEDIATION_DEVICES));
    expect(scheduleSoftwareRemediation).not.toHaveBeenCalled();
  });

  it('caps the implicit violating set at the limit (route parity)', async () => {
    const limits: number[] = [];
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call += 1;
      if (call === 1) return chain([POLICY]);
      return chain(ids(3).map((deviceId) => ({ deviceId })), (n) => limits.push(n));
    });
    const result = JSON.parse(await handlerFor('remediate_software_violation')({ policyId: 'pol-1' }, auth));
    // One past the cap, so truncation is detectable (review fix, #6758).
    expect(limits).toContain(MAX_REMEDIATION_DEVICES + 1);
    expect(result.truncated).toBeUndefined();
  });

  it('an implicit set over the cap schedules the first batch and SAYS it was truncated', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call += 1;
      if (call === 1) return chain([POLICY]);
      return chain(ids(MAX_REMEDIATION_DEVICES + 1).map((deviceId) => ({ deviceId })));
    });
    vi.mocked(scheduleSoftwareRemediation).mockResolvedValueOnce(MAX_REMEDIATION_DEVICES);
    const result = JSON.parse(await handlerFor('remediate_software_violation')({ policyId: 'pol-1' }, auth));
    expect(vi.mocked(scheduleSoftwareRemediation).mock.calls[0]![1]).toHaveLength(MAX_REMEDIATION_DEVICES);
    expect(result).toMatchObject({ truncated: true, maxDevices: MAX_REMEDIATION_DEVICES });
    expect(result.message).toMatch(/more violating devices remain/i);
  });

  it('schedules an explicit list at exactly the cap', async () => {
    mockDb.select.mockImplementation(() => chain([POLICY]));
    const result = JSON.parse(await handlerFor('remediate_software_violation')({
      policyId: 'pol-1', deviceIds: ids(MAX_REMEDIATION_DEVICES),
    }, auth));
    expect(result.queued).toBe(MAX_REMEDIATION_DEVICES);
    expect(scheduleSoftwareRemediation).toHaveBeenCalledTimes(1);
  });
});
