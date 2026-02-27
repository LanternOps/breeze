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
import { writeAuditEvent } from '../../services/auditEvents';
import { publishEvent } from '../../services/eventBus';
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

function mockDeviceNotFound() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([])
      })
    })
  } as any);
}

function mockPolicyLookup(validPolicies: { id: string }[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(validPolicies)
    })
  } as any);
}

function mockInsert(insertedRows: { id: string }[]) {
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(insertedRows)
      })
    })
  } as any);
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-1',
    eventType: 'connected',
    peripheralType: 'storage',
    occurredAt: '2026-02-26T12:00:00.000Z',
    ...overrides,
  };
}

describe('agent peripheral ingest', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', async (c: any, next: any) => {
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

  it('returns 404 when device is not found', async () => {
    mockDeviceNotFound();

    const res = await app.request('/agents/agent-1/peripherals/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [makeEvent()]
      })
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Device not found' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns 403 on organization mismatch', async () => {
    // Agent has orgId 'org-A' but device belongs to 'org-B'
    const orgMismatchApp = new Hono();
    orgMismatchApp.use('*', async (c: any, next: any) => {
      c.set('agent', { orgId: 'org-A', agentId: 'agent-1' });
      await next();
    });
    orgMismatchApp.route('/agents', peripheralRoutes);

    mockDeviceLookup({ id: 'device-1', orgId: 'org-B', hostname: 'host-1' });

    const res = await orgMismatchApp.request('/agents/agent-1/peripherals/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [makeEvent()]
      })
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Organization mismatch' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('reports blockedPublishFailures when publishEvent rejects', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1', hostname: 'host-1' });
    mockInsert([{ id: 'inserted-1' }, { id: 'inserted-2' }]);

    vi.mocked(publishEvent).mockRejectedValue(new Error('Redis connection lost'));

    const res = await app.request('/agents/agent-1/peripherals/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          makeEvent({ eventId: 'evt-1', eventType: 'blocked' }),
          makeEvent({ eventId: 'evt-2', eventType: 'blocked' }),
        ]
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blockedPublishFailures).toBe(2);
    expect(body.blockedCount).toBe(2);
    expect(publishEvent).toHaveBeenCalledTimes(2);
  });

  it('returns a correct happy-path success response for non-blocked events', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1', hostname: 'host-1' });
    mockInsert([{ id: 'inserted-1' }, { id: 'inserted-2' }]);

    const res = await app.request('/agents/agent-1/peripherals/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          makeEvent({ eventId: 'evt-1', eventType: 'connected' }),
          makeEvent({ eventId: 'evt-2', eventType: 'disconnected' }),
        ]
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      count: 2,
      deduplicatedCount: 0,
      blockedCount: 0,
    });
    // publishEvent should NOT be called for non-blocked events
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('writes an audit event with correct arguments', async () => {
    mockDeviceLookup({ id: 'device-1', orgId: 'org-1', hostname: 'host-1' });
    mockInsert([{ id: 'inserted-1' }]);

    const res = await app.request('/agents/agent-1/peripherals/events', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          makeEvent({ eventId: 'evt-1', eventType: 'connected' }),
        ]
      })
    });

    expect(res.status).toBe(200);
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    const [, auditPayload] = vi.mocked(writeAuditEvent).mock.calls[0]!;
    expect(auditPayload).toMatchObject({
      orgId: 'org-1',
      actorType: 'agent',
      actorId: 'agent-1',
      action: 'agent.peripheral_events.submit',
      resourceType: 'device',
      resourceId: 'device-1',
      resourceName: 'host-1',
      details: {
        submittedCount: 1,
        insertedCount: 1,
        deduplicatedCount: 0,
        blockedCount: 0,
        blockedPublishFailures: 0,
      },
    });
  });
});
