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

vi.mock('../../db', () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
  },
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
  const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
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
          }),
        ],
      })
    );
  });
});
