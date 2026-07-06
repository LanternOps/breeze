import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', agentId: 'devices.agentId' },
}));

vi.mock('../../middleware/requireAgentRole', () => ({
  requireAgentRole: async (c: any, next: any) => {
    c.set('agent', { agentId: 'agent-1', orgId: '22222222-2222-4222-8222-222222222222', role: 'agent' });
    await next();
  },
}));

const { escrowMock, auditMock } = vi.hoisted(() => ({
  escrowMock: vi.fn(async () => ({ inserted: 1, superseded: 0, unchanged: 0 })),
  auditMock: vi.fn(),
}));

vi.mock('../../services/recoveryKeyEscrow', () => ({ escrowRecoveryKeys: escrowMock }));
vi.mock('../../services/auditEvents', () => ({ writeAuditEvent: auditMock }));

import { db } from '../../db';
import { agentRecoveryKeysRoutes } from './recoveryKeys';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const KEY = '111111-222222-333333-444444-555555-666666-777777-888888';

function buildApp() {
  const app = new Hono();
  app.route('/', agentRecoveryKeysRoutes);
  return app;
}

function mockDeviceLookup(row: unknown) {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  });
}

const validBody = {
  source: 'snapshot',
  keys: [{ keyType: 'bitlocker_recovery_password', volumeMount: 'C:', protectorId: 'p-1', recoveryKey: KEY }],
};

describe('PUT /:id/security/recovery-keys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('escrows keys for the resolved device and audits counts only', async () => {
    mockDeviceLookup({ id: DEVICE_ID, orgId: ORG_ID });
    const res = await buildApp().request('/agent-1/security/recovery-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    expect(escrowMock).toHaveBeenCalledWith(DEVICE_ID, ORG_ID, 'snapshot', validBody.keys);
    const auditArg = auditMock.mock.calls[0][1];
    expect(JSON.stringify(auditArg)).not.toContain(KEY);
    expect(auditArg.action).toBe('agent.recovery_keys.submit');
  });

  it('404s when the agent id resolves to no device', async () => {
    mockDeviceLookup(null);
    const res = await buildApp().request('/nope/security/recovery-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(404);
    expect(escrowMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid keyType with 400', async () => {
    mockDeviceLookup({ id: DEVICE_ID, orgId: ORG_ID });
    const res = await buildApp().request('/agent-1/security/recovery-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'snapshot', keys: [{ keyType: 'luks', recoveryKey: KEY }] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing source with 400', async () => {
    mockDeviceLookup({ id: DEVICE_ID, orgId: ORG_ID });
    const res = await buildApp().request('/agent-1/security/recovery-keys', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [] }),
    });
    expect(res.status).toBe(400);
  });
});
