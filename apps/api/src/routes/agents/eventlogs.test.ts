import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  rateLimiter: vi.fn(),
  getDeviceEventLogSettings: vi.fn(),
  enqueueLogForwarding: vi.fn(),
  getOrgForwardingConfig: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

// #1105 depth-tracking: withDbAccessContext increments/decrements a shared
// counter around its callback so a test can prove a given call (e.g. the
// forwarding enqueue) runs OUTSIDE the request's held DB context, mirroring
// the real request-long wrap agentAuthMiddleware opens around this route.
let contextDepth = 0;
vi.mock('../../db', () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    contextDepth -= 1;
    try {
      return fn();
    } finally {
      contextDepth += 1;
    }
  }),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => {
    contextDepth += 1;
    try {
      return await fn();
    } finally {
      contextDepth -= 1;
    }
  }),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    agentId: 'devices.agentId',
    orgId: 'devices.orgId',
  },
  deviceEventLogs: {},
}));

vi.mock('../../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../../services/rate-limit', () => ({
  rateLimiter: mocks.rateLimiter,
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: mocks.writeAuditEvent,
}));

vi.mock('../../jobs/logForwardingWorker', () => ({
  enqueueLogForwarding: mocks.enqueueLogForwarding,
}));

vi.mock('../../services/logForwarding', () => ({
  getOrgForwardingConfig: mocks.getOrgForwardingConfig,
}));

vi.mock('./helpers', () => {
  const sanitizeTimestamp = (value: unknown): Date | null => {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  return {
    EVENT_LOG_DEFAULTS: {
      enabled: true,
      minimumLevel: 'info',
      categories: [],
      rateLimitPerHour: 1000,
      retentionDays: 30,
    },
    sanitizeTimestamp,
    getDeviceEventLogSettings: mocks.getDeviceEventLogSettings,
  };
});

import { withDbAccessContext } from '../../db';
import { eventLogsRoutes } from './eventlogs';

function mockDeviceLookup() {
  mocks.select.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([
          { id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID, hostname: 'win-01' },
        ]),
      }),
    }),
  });
}

function mockInsertSuccess() {
  // .returning() echoes the inserted batch (no conflicts) — mirrors the route
  // chain db.insert().values().onConflictDoNothing().returning().
  let captured: Array<Record<string, unknown>> = [];
  const returning = vi.fn().mockImplementation(async () =>
    captured.map((r) => ({ source: r.source, eventId: r.eventId, timestamp: r.timestamp })));
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockImplementation((batch: Array<Record<string, unknown>>) => {
    captured = batch;
    return { onConflictDoNothing };
  });
  mocks.insert.mockReturnValue({ values });
  return values;
}

function mockInsertAllConflicts() {
  // Every row hits the device_event_logs_dedup_idx — .returning() is empty.
  const returning = vi.fn().mockResolvedValue([]);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  mocks.insert.mockReturnValue({ values });
  return values;
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-05-02T12:00:00.000Z',
    level: 'critical',
    category: 'security',
    source: 'Security',
    eventId: '4625',
    message: 'failed login',
    ...overrides,
  };
}

describe('agent event log routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T12:00:00.000Z'));

    app = new Hono();
    // Simulate agentAuthMiddleware setting the main-agent credential so the
    // requireAgentRole guard on eventLogsRoutes lets ingest tests through.
    app.use('*', async (c, next) => {
      c.set('agent', { deviceId: 'dev-1', agentId: 'agent-1', orgId: 'org-1', siteId: 'site-1', role: 'agent' } as never);
      return next();
    });
    app.route('/agents', eventLogsRoutes);

    mocks.getDeviceEventLogSettings.mockResolvedValue({
      minimumLevel: 'info',
      rateLimitPerHour: 1000,
    });
    mocks.rateLimiter.mockResolvedValue({
      allowed: true,
      remaining: 999,
      resetAt: new Date('2026-05-02T13:00:00.000Z'),
    });
    mocks.getOrgForwardingConfig.mockResolvedValue({ endpoint: 'https://logs.example.com' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clamps excessive future event timestamps before storing and forwarding', async () => {
    mockDeviceLookup();
    const values = mockInsertSuccess();

    const res = await app.request(`/agents/${AGENT_ID}/eventlogs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [
          makeEvent({
            timestamp: '2026-05-02T13:00:00.000Z',
            details: { eventRecordId: 123 },
          }),
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        timestamp: new Date('2026-05-02T12:00:00.000Z'),
        details: {
          eventRecordId: 123,
          originalTimestamp: '2026-05-02T13:00:00.000Z',
          timestampClamped: true,
        },
      }),
    ]);
    expect(mocks.enqueueLogForwarding).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            timestamp: '2026-05-02T12:00:00.000Z',
            // Regression guard (#2643): forward the persisted `details`, not the
            // non-existent `rawData` the schema strips. The clamp provenance
            // that was merged into the stored row is forwarded too.
            details: {
              eventRecordId: 123,
              originalTimestamp: '2026-05-02T13:00:00.000Z',
              timestampClamped: true,
            },
          }),
        ],
      })
    );
    // The removed `rawData` field must not resurface in the forward payload.
    const forwarded = mocks.enqueueLogForwarding.mock.calls[0]?.[0];
    expect(forwarded.events[0]).not.toHaveProperty('rawData');
  });

  it('enqueues log forwarding OUTSIDE the held request DB context (#6097 / #1105)', async () => {
    mockDeviceLookup();
    mockInsertSuccess();

    let depthDuringEnqueue: number | null = null;
    mocks.enqueueLogForwarding.mockImplementation(async () => {
      depthDuringEnqueue = contextDepth;
    });

    // Simulate agentAuthMiddleware's request-long withDbAccessContext wrap
    // around the whole handler (eventlogs.ts does not opt out via
    // SELF_MANAGED_DB_CONTEXT_ACTIONS, so the real middleware holds this
    // open for the entire request).
    const res = await withDbAccessContext(
      { scope: 'organization', orgId: 'org-1' } as never,
      async () => app.request(`/agents/${AGENT_ID}/eventlogs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [makeEvent()] }),
      })
    );

    expect(res.status).toBe(200);
    expect(mocks.enqueueLogForwarding).toHaveBeenCalled();
    // depth 0 == outside every withDbAccessContext; depth 1 would mean the
    // enqueue ran while the request's pooled connection was still pinned.
    expect(depthDuringEnqueue).toBe(0);
  });

  it('does not re-forward duplicate events absorbed by the dedup index (#2390 retry passes)', async () => {
    mockDeviceLookup();
    mockInsertAllConflicts();

    const res = await app.request(`/agents/${AGENT_ID}/eventlogs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [makeEvent()] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0); // nothing actually inserted
    expect(mocks.enqueueLogForwarding).not.toHaveBeenCalled();
  });
});

describe('eventlogs ingest — requireAgentRole gate (F8)', () => {
  it('rejects a watchdog-role token with 403', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', { deviceId: 'dev-1', agentId: 'agent-1', orgId: 'org-1', siteId: 'site-1', role: 'watchdog' } as never);
      return next();
    });
    app.route('/agents', eventLogsRoutes);
    const res = await app.request('/agents/dev-1/eventlogs', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});
