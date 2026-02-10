import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { policyRoutes } from './policyManagement';

vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  }
}));

vi.mock('../db/schema', () => ({
  automationPolicies: {
    id: {},
    orgId: {},
    name: {},
    enabled: {},
    enforcement: {},
    updatedAt: {},
    checkIntervalMinutes: {},
    lastEvaluatedAt: {},
    remediationScriptId: {},
  },
  automationPolicyCompliance: {
    id: {},
    policyId: {},
    deviceId: {},
    status: {},
    details: {},
    lastCheckedAt: {},
    remediationAttempts: {},
    updatedAt: {},
  },
  automations: {
    id: {},
    orgId: {},
    enabled: {},
    runCount: {},
    lastRunAt: {},
  },
  automationRuns: {
    id: {},
    status: {},
    startedAt: {},
  },
  devices: {
    id: {},
    hostname: {},
  },
  organizations: {
    id: {},
    partnerId: {},
  },
  scripts: {
    id: {},
    orgId: {},
  },
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/policyEvaluationService', () => ({
  evaluatePolicy: vi.fn(),
  resolvePolicyRemediationAutomationId: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      scope: 'system',
      partnerId: null,
      orgId: null,
      accessibleOrgIds: null,
      canAccessOrg: () => true,
      user: { id: 'user-123', email: 'test@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c, next) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  })
}));

import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { evaluatePolicy, resolvePolicyRemediationAutomationId } from '../services/policyEvaluationService';

const orgId = '123e4567-e89b-42d3-a456-426614174000';
const policyId = '223e4567-e89b-42d3-a456-426614174001';

const basePolicyRow = {
  id: policyId,
  orgId,
  name: 'Endpoint Baseline',
  description: 'Ensure baseline configuration.',
  enabled: true,
  targets: { targetType: 'all', targetIds: [] },
  rules: [{ type: 'config_check', configFilePath: '/etc/example.conf', configKey: 'enabled', configExpectedValue: 'true' }],
  enforcement: 'monitor',
  checkIntervalMinutes: 30,
  remediationScriptId: null,
  createdBy: 'user-123',
  createdAt: new Date('2026-02-07T00:00:00.000Z'),
  updatedAt: new Date('2026-02-07T00:00:00.000Z'),
  lastEvaluatedAt: null,
};

describe('policy routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authMiddleware).mockImplementation((c, next) => {
      c.set('auth', {
        scope: 'system',
        partnerId: null,
        orgId: null,
        accessibleOrgIds: null,
        canAccessOrg: () => true,
        user: { id: 'user-123', email: 'test@example.com' }
      });
      return next();
    });
    app = new Hono();
    app.route('/policies', policyRoutes);
  });

  it('lists policies from the canonical /policies endpoint', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([basePolicyRow]),
              }),
            }),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    const res = await app.request('/policies?limit=2', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(policyId);
    expect(body.pagination.total).toBe(1);
  });

  it('creates a policy', async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([basePolicyRow]),
      }),
    } as any);

    const res = await app.request('/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId,
        name: 'Endpoint Baseline',
        description: 'Ensure baseline configuration.',
        rules: [{ type: 'config_check', configFilePath: '/etc/example.conf', configKey: 'enabled', configExpectedValue: 'true' }],
        targetType: 'all',
        enforcementLevel: 'monitor',
        checkIntervalMinutes: 30,
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(policyId);
    expect(body.enforcementLevel).toBe('monitor');
  });

  it('rejects missing targetIds for scoped policies', async () => {
    const res = await app.request('/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId,
        name: 'Scoped Policy',
        targetType: 'sites',
        rules: [{ type: 'config_check', configFilePath: '/etc/example.conf', configKey: 'enabled', configExpectedValue: 'true' }],
      })
    });

    expect(res.status).toBe(400);
  });

  it('rejects non-UUID targetIds for non-tag targets', async () => {
    const res = await app.request('/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId,
        name: 'Scoped Policy',
        targetType: 'sites',
        targetIds: ['production'],
        rules: [{ type: 'config_check', configFilePath: '/etc/example.conf', configKey: 'enabled', configExpectedValue: 'true' }],
      })
    });

    expect(res.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('allows string targetIds for tags and preserves them in targets', async () => {
    const valuesMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{
        ...basePolicyRow,
        targets: {
          targetType: 'tags',
          targetIds: ['production'],
          tags: ['production'],
        },
      }]),
    });

    vi.mocked(db.insert).mockReturnValue({
      values: valuesMock,
    } as any);

    const res = await app.request('/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId,
        name: 'Tag Policy',
        targetType: 'tags',
        targetIds: ['production'],
        rules: [{ type: 'config_check', configFilePath: '/etc/example.conf', configKey: 'enabled', configExpectedValue: 'true' }],
      })
    });

    expect(res.status).toBe(201);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.objectContaining({
          targetType: 'tags',
          targetIds: ['production'],
          tags: ['production'],
        }),
      })
    );
  });

  it('rejects invalid rules during policy creation', async () => {
    const res = await app.request('/policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId,
        name: 'Invalid Rule Policy',
        targetType: 'all',
        rules: [{ type: 'required_software', versionOperator: 'minimum' }],
      })
    });

    expect(res.status).toBe(400);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('evaluates a policy through policyEvaluationService', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([basePolicyRow]),
        }),
      }),
    } as any);

    vi.mocked(evaluatePolicy).mockResolvedValue({
      message: 'Policy evaluation completed',
      policyId,
      devicesEvaluated: 1,
      results: [],
      summary: { compliant: 1, non_compliant: 0 },
      evaluatedAt: new Date().toISOString(),
    });

    const res = await app.request(`/policies/${policyId}/evaluate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(evaluatePolicy).toHaveBeenCalled();
  });

  it('returns remediation configuration error when no automation is mapped', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([basePolicyRow]),
        }),
      }),
    } as any);
    vi.mocked(resolvePolicyRemediationAutomationId).mockResolvedValue(null);

    const res = await app.request(`/policies/${policyId}/remediate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(400);
  });

  it('removes policy and compliance records', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([basePolicyRow]),
        }),
      }),
    } as any);

    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as any);

    const res = await app.request(`/policies/${policyId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('does not expose legacy assignments endpoints', async () => {
    const res = await app.request(`/policies/${policyId}/assignments`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
  });
});
