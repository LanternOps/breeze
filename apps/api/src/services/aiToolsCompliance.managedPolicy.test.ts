/**
 * #6960: a software policy generated from a `security_agents` config-policy
 * link (managed_by_link_id set) is read-only to the AI compliance tools:
 * update, soft-delete and manual remediation all refuse and write nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn(async () => 'job-1') }));
vi.mock('../jobs/softwareRemediationWorker', () => ({ scheduleSoftwareRemediation: vi.fn(async () => 1) }));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { db } from '../db';
import { scheduleSoftwareRemediation } from '../jobs/softwareRemediationWorker';
import { registerComplianceTools } from './aiToolsCompliance';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

const ORG_ID = 'org-1';
const POLICY_ID = 'pol-1';
const CONFIG_POLICY_ID = 'cp-1';

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerComplianceTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'ai@example.com', name: 'AI', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset', 'set', 'values', 'returning']) {
    p[m] = () => p;
  }
  return p;
}

const MANAGED = {
  id: POLICY_ID,
  orgId: ORG_ID,
  partnerId: null,
  name: 'Security agents',
  mode: 'allowlist',
  enforceMode: true,
  remediationOptions: { autoInstall: true, autoUninstall: false },
  isActive: true,
  rules: { software: [], allowUnknown: true },
  managedByLinkId: 'link-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.select
    .mockReset()
    .mockImplementationOnce(() => chain([MANAGED]))
    .mockImplementationOnce(() => chain([{ configPolicyId: CONFIG_POLICY_ID }]));
});

describe('AI compliance tools refuse a generated software policy (#6960)', () => {
  it.each([
    ['manage_software_policy', { action: 'update', policyId: POLICY_ID, name: 'Renamed' }],
    ['manage_software_policy', { action: 'delete', policyId: POLICY_ID }],
    ['remediate_software_violation', { policyId: POLICY_ID, deviceIds: ['dev-1'] }],
  ])('%s %j → read-only refusal, nothing written or queued', async (tool, input) => {
    const out = JSON.parse(await handlerFor(tool)(input, makeAuth()));
    expect(out).toMatchObject({ code: 'managed_software_policy_read_only', configPolicyId: CONFIG_POLICY_ID });
    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(scheduleSoftwareRemediation).not.toHaveBeenCalled();
  });
});
