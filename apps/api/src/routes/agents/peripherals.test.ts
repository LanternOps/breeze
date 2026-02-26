import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  }
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'id', orgId: 'orgId', hostname: 'hostname', agentId: 'agentId' },
  peripheralEventTypeEnum: { enumValues: ['connected', 'disconnected', 'blocked', 'mounted_read_only', 'policy_override'] },
  peripheralEvents: { id: 'id' },
  peripheralPolicies: { id: 'id', orgId: 'orgId' }
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn()
}));

vi.mock('../../services/eventBus', () => ({
  publishEvent: vi.fn()
}));

import { db } from '../../db';
import { peripheralRoutes } from './peripherals';

function mockDeviceLookup(device: { id: string; orgId: string; hostname: string }) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([device])
      })
    })
  } as any);
}

describe('agent peripheral ingest', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', { orgId: 'org-1', agentId: 'agent-1' });
      await next();
    });
    app.route('/agents', peripheralRoutes);
  });

  it('rejects policy IDs outside device org scope', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1', hostname: 'host-1' });

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([])
      })
    } as any);

    const res = await app.request('/agents/agent-1/peripherals/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt-1',
            policyId: '11111111-1111-1111-1111-111111111111',
            eventType: 'blocked',
            peripheralType: 'storage',
            occurredAt: '2026-02-26T12:00:00.000Z'
          }
        ]
      })
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.invalidPolicyIds).toHaveLength(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('reports deduplicated count when onConflictDoNothing skips duplicates', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1', hostname: 'host-1' });

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: '11111111-1111-1111-1111-111111111111' }])
      })
    } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'inserted-1' }])
        })
      })
    } as any);

    const res = await app.request('/agents/agent-1/peripherals/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          {
            eventId: 'evt-1',
            policyId: '11111111-1111-1111-1111-111111111111',
            eventType: 'connected',
            peripheralType: 'storage',
            occurredAt: '2026-02-26T12:00:00.000Z'
          },
          {
            eventId: 'evt-1',
            policyId: '11111111-1111-1111-1111-111111111111',
            eventType: 'connected',
            peripheralType: 'storage',
            occurredAt: '2026-02-26T12:00:01.000Z'
          }
        ]
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.deduplicatedCount).toBe(1);
  });
});
