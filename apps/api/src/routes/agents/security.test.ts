import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    agentId: 'devices.agentId',
    managementPosture: 'devices.managementPosture',
    updatedAt: 'devices.updatedAt',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('./helpers', () => ({
  upsertSecurityStatusForDevice: vi.fn(),
}));

import { agentSecurityRoutes } from './security';

describe('agent security ingest role gate', () => {
  it('rejects requests without the main agent credential context', async () => {
    const app = new Hono();
    app.route('/agents', agentSecurityRoutes);

    const res = await app.request('/agents/agent-1/security/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'windows_defender',
        realTimeProtection: true,
      }),
    });

    expect(res.status).toBe(403);
  });
});
