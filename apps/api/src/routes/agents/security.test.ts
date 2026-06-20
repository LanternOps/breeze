import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { db } from '../../db';
import { agentSecurityRoutes } from './security';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

vi.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', agentId: 'devices.agentId', orgId: 'devices.orgId' },
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('./helpers', () => ({
  upsertSecurityStatusForDevice: vi.fn(async () => undefined),
}));

function mountWithRole(role: 'agent' | 'watchdog' | undefined): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    // Simulate agentAuthMiddleware setting the credential context.
    if (role) {
      c.set('agent', {
        deviceId: DEVICE_ID,
        agentId: AGENT_ID,
        orgId: ORG_ID,
        siteId: 'site-1',
        role,
      } as never);
    }
    return next();
  });
  app.route('/agents', agentSecurityRoutes);
  return app;
}

function mockDeviceLookup() {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: ORG_ID }]),
      }),
    }),
  } as never);
  vi.mocked(db.update).mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  } as never);
}

describe('agent security routes — requireAgentRole gate (F3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PUT /agents/:id/security/status', () => {
    it('rejects a watchdog-role token with 403', async () => {
      const app = mountWithRole('watchdog');
      const res = await app.request(`/agents/${AGENT_ID}/security/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'defender', threatCount: 0 }),
      });
      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('allows the main agent-role token', async () => {
      mockDeviceLookup();
      const app = mountWithRole('agent');
      const res = await app.request(`/agents/${AGENT_ID}/security/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'defender', threatCount: 0 }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe('PUT /agents/:id/management/posture', () => {
    const validPosture = {
      collectedAt: '2026-06-20T00:00:00.000Z',
      scanDurationMs: 0,
      categories: {},
      identity: {
        joinType: 'none',
        azureAdJoined: false,
        domainJoined: false,
        workplaceJoined: false,
        source: 'agent',
      },
    };

    it('rejects a watchdog-role token with 403', async () => {
      const app = mountWithRole('watchdog');
      const res = await app.request(`/agents/${AGENT_ID}/management/posture`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPosture),
      });
      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('allows the main agent-role token', async () => {
      mockDeviceLookup();
      const app = mountWithRole('agent');
      const res = await app.request(`/agents/${AGENT_ID}/management/posture`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPosture),
      });
      expect(res.status).toBe(200);
    });
  });
});
