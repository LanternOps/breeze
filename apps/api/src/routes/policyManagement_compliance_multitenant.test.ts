import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { policyRoutes } from './policyManagement';

const POLICY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const POLICY_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const SCRIPT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AUTOMATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/policyEvaluationService', () => ({
  evaluatePolicy: vi.fn().mockResolvedValue({
    devicesEvaluated: 5,
    compliant: 3,
    nonCompliant: 2
  }),
  resolvePolicyRemediationAutomationId: vi.fn().mockResolvedValue(null)
}));

vi.mock('../utils/pagination', () => ({
  getPagination: vi.fn((query: { page?: string; limit?: string }) => {
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
    return { page, limit, offset: (page - 1) * limit };
  })
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  automationPolicies: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    description: 'description',
    enabled: 'enabled',
    targets: 'targets',
    rules: 'rules',
    enforcement: 'enforcement',
    checkIntervalMinutes: 'checkIntervalMinutes',
    remediationScriptId: 'remediationScriptId',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  },
  automationPolicyCompliance: {
    id: 'id',
    policyId: 'policyId',
    configPolicyId: 'configPolicyId',
    configItemName: 'configItemName',
    deviceId: 'deviceId',
    status: 'status',
    details: 'details',
    lastCheckedAt: 'lastCheckedAt',
    remediationAttempts: 'remediationAttempts',
    updatedAt: 'updatedAt'
  },
  configPolicyFeatureLinks: {
    id: 'id',
    configPolicyId: 'configPolicyId'
  },
  configPolicyComplianceRules: {
    id: 'id',
    featureLinkId: 'featureLinkId',
    name: 'name',
    enforcementLevel: 'enforcementLevel'
  },
  configurationPolicies: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    status: 'status'
  },
  scripts: {
    id: 'id',
    name: 'name'
  },
  devices: {
    id: 'id',
    hostname: 'hostname',
    status: 'status',
    osType: 'osType',
    orgId: 'orgId'
  },
  automations: {
    id: 'id',
    orgId: 'orgId',
    enabled: 'enabled',
    runCount: 'runCount',
    lastRunAt: 'lastRunAt',
    updatedAt: 'updatedAt'
  },
  automationRuns: {
    id: 'id',
    status: 'status',
    startedAt: 'startedAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

function makePolicy(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID,
    orgId: ORG_ID,
    name: 'Test Policy',
    description: 'A test policy',
    enabled: true,
    targets: { targetType: 'all', targetIds: [] },
    rules: [{ type: 'required_software', softwareName: 'Chrome' }],
    enforcement: 'monitor',
    checkIntervalMinutes: 60,
    remediationScriptId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides
  };
}


describe('policyManagement routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      });
      return next();
    });
    app = new Hono();
    app.route('/policies', policyRoutes);
  });

  // ----------------------------------------------------------------
  // GET /:id/compliance (compliance.ts)
  // ----------------------------------------------------------------
  describe('GET /policies/:id/compliance', () => {
    it('should return compliance details for a legacy policy', async () => {
      const policy = makePolicy();
      vi.mocked(db.select)
        // getPolicyWithOrgCheck
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([policy])
            })
          })
        } as any)
        // count query
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 3 }])
          })
        } as any)
        // compliance rows
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue([
                      {
                        id: 'comp-1',
                        policyId: POLICY_ID,
                        configPolicyId: null,
                        configItemName: null,
                        deviceId: 'device-1',
                        status: 'compliant',
                        details: null,
                        lastCheckedAt: new Date('2026-01-01'),
                        remediationAttempts: 0,
                        updatedAt: new Date('2026-01-01'),
                        deviceHostname: 'host-1',
                        deviceStatus: 'online',
                        deviceOsType: 'windows'
                      }
                    ])
                  })
                })
              })
            })
          })
        } as any);

      const res = await app.request(`/policies/${POLICY_ID}/compliance`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.overall).toBeDefined();
      expect(body.policyName).toBe('Test Policy');
    });

    it('should return 404 for non-existent policy', async () => {
      // getPolicyWithOrgCheck returns null
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any)
        // Try as config policy - also not found
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request(`/policies/${POLICY_ID}/compliance`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  // ----------------------------------------------------------------
  // Partner scope tests
  // ----------------------------------------------------------------
  describe('partner scope access', () => {
    beforeEach(() => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'partner@example.com', name: 'Partner' },
          scope: 'partner',
          orgId: null,
          partnerId: PARTNER_ID,
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (orgId: string) => orgId === ORG_ID
        });
        return next();
      });
    });

    it('should list policies for accessible org', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 1 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([makePolicy()])
                })
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const res = await app.request(`/policies?orgId=${ORG_ID}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

});
