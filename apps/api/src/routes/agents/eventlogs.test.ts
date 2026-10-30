import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'org-1';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  rateLimiter: vi.fn(),
  checkAndConsumeIngestQuota: vi.fn(),
  getDeviceEventLogSettings: vi.fn(),
  enqueueLogForwarding: vi.fn(),
  getOrgForwardingConfig: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

// #1105 / #6097 — depth-tracking: withDbAccessContext increments/decrements a
// shared counter around its callback so a test can prove the Redis-only work
// (rate limiter, forwarding enqueue) runs with NO context open at all — real
// exits of the (mocked) `baseDb.transaction` callback, not merely outside the
// AsyncLocalStorage store the way `runOutsideDbContext` alone would leave it.
// `eventlogs` is now in SELF_MANAGED_DB_CONTEXT_ACTIONS (agentAuth.ts), so
// there is no outer middleware wrap in production — the route opens its own
// two short contexts, tracked here the same way reliability.test.ts does.
let contextDepth = 0;
const dbContextCalls: Array<Record<string, unknown>> = [];
vi.mock('../../db', () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
  },
  withDbAccessContext: vi.fn(async (ctx: Record<string, unknown>, fn: () => Promise<unknown>) => {
    dbContextCalls.push(ctx);
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

vi.mock('../../services/ingestQuota', () => ({
  checkAndConsumeIngestQuota: mocks.checkAndConsumeIngestQuota,
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

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

const recordAgentIngestSubmission = vi.hoisted(() => vi.fn());
vi.mock('../metrics', () => ({ recordAgentIngestSubmission }));

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
import { EVENT_LOG_EMPTY_MESSAGE_PLACEHOLDER } from './schemas';

function mockDeviceLookup(overrides: Record<string, unknown> = {}) {
  mocks.select.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([
          { id: DEVICE_ID, agentId: AGENT_ID, orgId: ORG_ID, hostname: 'win-01', ...overrides },
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
    contextDepth = 0;
    dbContextCalls.length = 0;

    app = new Hono();
    // Simulate agentAuthMiddleware setting the main-agent credential. Since
    // `eventlogs` is self-managed (SELF_MANAGED_DB_CONTEXT_ACTIONS), the real
    // middleware does NOT also wrap this route in its own request-long
    // withDbAccessContext — only the agent context is set here.
    app.use('*', async (c, next) => {
      c.set('agent', { deviceId: 'dev-1', agentId: 'agent-1', orgId: ORG_ID, partnerId: 'partner-1', siteId: 'site-1', role: 'agent' } as never);
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
    mocks.checkAndConsumeIngestQuota.mockResolvedValue({ allowed: true, rowsUsed: 1, bytesUsed: 100 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('per-row validation (#10494)', () => {
    const submit = (events: unknown) => app.request(`/agents/${AGENT_ID}/eventlogs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each(['', '   '])('coerces a blank message %j while preserving every row', async (message) => {
      mockDeviceLookup();
      const values = mockInsertSuccess();
      const events = [
        makeEvent({ eventId: '1', message: 'first' }),
        makeEvent({ eventId: '2', message }),
        makeEvent({ eventId: '3', message: 'last' }),
      ];
      const res = await submit(events);
      expect(res.status).toBe(200);
      expect(EVENT_LOG_EMPTY_MESSAGE_PLACEHOLDER).toBe('(no message text)');
      expect(values).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ eventId: '1', message: 'first' }),
        expect.objectContaining({ eventId: '2', message: EVENT_LOG_EMPTY_MESSAGE_PLACEHOLDER }),
        expect.objectContaining({ eventId: '3', message: 'last' }),
      ]);
      expect(await res.json()).toMatchObject({
        success: true, count: 3, invalidDropped: 0, emptyMessageCoerced: 1,
      });
      // The SIEM must get the same coerced text the DB stored, not the raw ''.
      expect(mocks.enqueueLogForwarding).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        events: [
          expect.objectContaining({ message: 'first' }),
          expect.objectContaining({ message: EVENT_LOG_EMPTY_MESSAGE_PLACEHOLDER }),
          expect.objectContaining({ message: 'last' }),
        ],
      }));
    });

    it.each([
      ['oversized message', { message: 'a'.repeat(2001) }],
      ['oversized details', { details: { text: 'a'.repeat(65536) } }],
      ['missing message', { message: undefined }],
      ['null message', { message: null }],
      ['non-string message', { message: 42 }],
    ])('drops a row with %s and preserves valid row identities', async (_label, invalid) => {
      mockDeviceLookup();
      const values = mockInsertSuccess();
      const res = await submit([
        makeEvent({ eventId: '1', message: 'first' }),
        makeEvent({ eventId: '2', ...invalid }),
        makeEvent({ eventId: '3', message: 'last' }),
      ]);
      expect(res.status).toBe(200);
      expect(values).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ eventId: '1', message: 'first' }),
        expect.objectContaining({ eventId: '3', message: 'last' }),
      ]);
      expect(await res.json()).toMatchObject({
        success: true, count: 2, invalidDropped: 1, emptyMessageCoerced: 0,
      });
      // Forwarding pairs parsed events with inserted rows by index; a dropped
      // row must not shift one row's message onto another row's key.
      expect(mocks.enqueueLogForwarding).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        events: [
          expect.objectContaining({ message: 'first' }),
          expect.objectContaining({ message: 'last' }),
        ],
      }));
    });

    it('drops non-object rows inside a valid envelope without failing the batch', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockDeviceLookup();
      const values = mockInsertSuccess();
      const res = await submit([null, 42, 'x', [], makeEvent({ eventId: 'ok' })]);
      expect(res.status).toBe(200);
      expect(values).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ eventId: 'ok' })]);
      expect(await res.json()).toMatchObject({
        success: true, count: 1, invalidDropped: 4, emptyMessageCoerced: 0,
      });
      expect(warn.mock.calls[0]!.join(' ')).toContain('events[0]:invalid_type');
    });

    it('does not count a blank message as coerced when its row is dropped for another field', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockDeviceLookup();
      mockInsertSuccess();
      const res = await submit([makeEvent({ message: '', level: 'bogus' }), makeEvent()]);
      expect(await res.json()).toMatchObject({
        success: true, count: 1, invalidDropped: 1, emptyMessageCoerced: 0,
      });
    });

    it('does not warn for a clean batch', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockDeviceLookup();
      mockInsertSuccess();
      const res = await submit([makeEvent({ eventId: '1' }), makeEvent({ eventId: '2' })]);
      expect(res.status).toBe(200);
      expect(warn).not.toHaveBeenCalled();
    });

    it('names the rejected level/category value (bounded) so enum drift is diagnosable', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockDeviceLookup();
      mockInsertSuccess();
      await submit([
        makeEvent({ level: 'verbose' }),
        makeEvent({ category: `x${'y'.repeat(100)}` }),
        makeEvent(),
      ]);
      const line = warn.mock.calls[0]!.join(' ');
      expect(line).toContain('events[0].level:invalid_value="verbose"');
      expect(line).toContain(`events[1].category:invalid_value="x${'y'.repeat(31)}"`);
      expect(line).not.toContain('y'.repeat(32));
    });

    it('acknowledges an all-invalid batch without inserting', async () => {
      mockDeviceLookup();
      const res = await submit([
        makeEvent({ level: 'bogus' }), makeEvent({ message: 'a'.repeat(2001) }),
      ]);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true, count: 0, filtered: 0, invalidDropped: 2, emptyMessageCoerced: 0,
      });
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it('includes zero validation counts for an empty batch', async () => {
      const res = await submit([]);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true, count: 0, filtered: 0, invalidDropped: 0, emptyMessageCoerced: 0,
      });
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it.each([
      ['non-array events', 'invalid'],
      ['missing events', undefined],
      ['5001 events', Array.from({ length: 5001 }, () => makeEvent())],
    ])('keeps the envelope strict for %s', async (_label, events) => {
      const res = await submit(events);
      expect(res.status).toBe(400);
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it.each([
      ['level filter', 200], ['rate limit', 429], ['quota', 429], ['insert failure', 500],
    ])('includes validation counts after %s', async (outcome, status) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockDeviceLookup();
      mockInsertSuccess();
      if (outcome === 'level filter') {
        mocks.getDeviceEventLogSettings.mockResolvedValue({ minimumLevel: 'critical', rateLimitPerHour: 1000 });
      } else if (outcome === 'rate limit') {
        mocks.rateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
      } else if (outcome === 'quota') {
        mocks.checkAndConsumeIngestQuota.mockResolvedValue({ allowed: false, rowsUsed: 100, bytesUsed: 100 });
      } else {
        mocks.insert.mockReturnValue({ values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({ returning: vi.fn().mockRejectedValue(new Error('insert failed')) })),
        })) });
      }
      const res = await submit([
        makeEvent({ level: 'info', message: '' }), makeEvent({ message: null }),
      ]);
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({
        invalidDropped: 1, emptyMessageCoerced: 1,
        ...(outcome === 'level filter' ? { success: true, count: 0, filtered: 1 } : {}),
        ...(outcome === 'quota' ? { count: 0, filtered: 0, dropped: 1 } : {}),
        ...(outcome === 'insert failure' ? { success: false, count: 0, filtered: 0, expectedCount: 1 } : {}),
      });
      if (outcome === 'insert failure') {
        expect(mocks.writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
          details: expect.objectContaining({ invalidDroppedCount: 1, emptyMessageCoercedCount: 1 }),
        }));
      } else {
        expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
        expect(mocks.insert).not.toHaveBeenCalled();
      }
    });

    it.each([false, true])('adds counts only to existing audit triggers (clamped=%s)', async (clamped) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockDeviceLookup();
      mockInsertSuccess();
      const res = await submit([
        makeEvent({ message: '', ...(clamped ? { timestamp: '2026-05-02T13:00:00.000Z' } : {}) }),
        makeEvent({ message: null }),
      ]);
      expect(res.status).toBe(200);
      if (clamped) {
        expect(mocks.writeAuditEvent).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({
          details: expect.objectContaining({
            submittedCount: 2, insertedCount: 1, filteredCount: 0, timestampClampedCount: 1,
            invalidDroppedCount: 1, emptyMessageCoercedCount: 1,
          }),
        }));
      } else {
        expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
      }
    });

    it('warns once with counts and bounded issue paths, without logging contents', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockDeviceLookup();
      mockInsertSuccess();
      const secretMessage = 'private-message-'.repeat(150);
      const secretDetails = 'private-details-'.repeat(5000);
      const res = await submit([
        makeEvent({ message: '' }),
        ...Array.from({ length: 6 }, () => makeEvent({ message: secretMessage })),
        makeEvent({ details: { text: secretDetails } }),
      ]);
      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0]!.join(' ');
      expect(line).toMatch(/^\[EventLogs\]/);
      expect(line).toContain(`=${AGENT_ID}`);
      expect(line).toContain(`=${DEVICE_ID}`);
      expect(line).toContain('submitted=8');
      expect(line).toContain('invalidDropped=7');
      expect(line).toContain('emptyMessageCoerced=1');
      expect(line).toContain('events[1].message:too_big');
      expect((line.match(/events\[\d+\]/g) ?? []).length).toBeLessThanOrEqual(5);
      expect(line).not.toContain('private-message');
      expect(line).not.toContain('private-details');
    });
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

  it('drops the batch with 429 once the per-device daily byte budget is exceeded', async () => {
    mockDeviceLookup();
    const values = mockInsertSuccess();
    mocks.checkAndConsumeIngestQuota.mockResolvedValueOnce({
      allowed: false,
      rowsUsed: 1,
      bytesUsed: 3 * 1024 * 1024 * 1024,
    });

    const res = await app.request(`/agents/${AGENT_ID}/eventlogs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [makeEvent()] }),
    });

    expect(res.status).toBe(429);
    expect(values).not.toHaveBeenCalled();
  });

  it('drops the batch with 429 once the per-org daily row/byte budget is exceeded', async () => {
    mockDeviceLookup();
    const values = mockInsertSuccess();
    mocks.checkAndConsumeIngestQuota
      .mockResolvedValueOnce({ allowed: true, rowsUsed: 1, bytesUsed: 100 }) // device check
      .mockResolvedValueOnce({ allowed: false, rowsUsed: 2_000_100, bytesUsed: 100 }); // org check

    const res = await app.request(`/agents/${AGENT_ID}/eventlogs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [makeEvent()] }),
    });

    expect(res.status).toBe(429);
    expect(values).not.toHaveBeenCalled();
  });

  it('runs the rate limiter and the forwarding enqueue with NO DB context open (#6097 / #1105)', async () => {
    mockDeviceLookup();
    mockInsertSuccess();

    let depthDuringRateLimit: number | null = null;
    mocks.rateLimiter.mockImplementation(async () => {
      depthDuringRateLimit = contextDepth;
      return { allowed: true, remaining: 999, resetAt: new Date('2026-05-02T13:00:00.000Z') };
    });
    let depthDuringEnqueue: number | null = null;
    mocks.enqueueLogForwarding.mockImplementation(async () => {
      depthDuringEnqueue = contextDepth;
    });

    const res = await app.request(`/agents/${AGENT_ID}/eventlogs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [makeEvent()] }),
    });

    expect(res.status).toBe(200);
    expect(mocks.rateLimiter).toHaveBeenCalled();
    expect(mocks.enqueueLogForwarding).toHaveBeenCalled();
    // depth 0 == no withDbAccessContext callback currently on the stack, i.e.
    // no `baseDb.transaction` — not just outside the ALS store the way
    // `runOutsideDbContext` alone would leave it while the real transaction
    // (mocked here as the withDbAccessContext callback) is still open.
    expect(depthDuringRateLimit).toBe(0);
    expect(depthDuringEnqueue).toBe(0);
  });

  it('runs the device lookup and the insert inside an org-scoped context for the device\'s org', async () => {
    mockDeviceLookup();
    mockInsertSuccess();

    const res = await app.request(`/agents/${AGENT_ID}/eventlogs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [makeEvent()] }),
    });

    expect(res.status).toBe(200);
    // Two short contexts: phase 1 (lookup + settings), phase 2 (insert +
    // forwarding config) — both org-scoped to the agent's org, never system.
    expect(dbContextCalls).toHaveLength(2);
    for (const ctx of dbContextCalls) {
      expect(ctx.scope).toBe('organization');
      expect(ctx.orgId).toBe(ORG_ID);
      expect(ctx.accessibleOrgIds).toEqual([ORG_ID]);
      expect(ctx.currentPartnerId).toBe('partner-1');
    }
  });

  it('returns 401 when the agent context carries no org (never opens a vacuous context)', async () => {
    const noOrgApp = new Hono();
    noOrgApp.use('*', async (c, next) => {
      c.set('agent', { deviceId: 'dev-1', agentId: 'agent-1', orgId: undefined, siteId: 'site-1', role: 'agent' } as never);
      return next();
    });
    noOrgApp.route('/agents', eventLogsRoutes);

    const res = await noOrgApp.request(`/agents/${AGENT_ID}/eventlogs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [makeEvent()] }),
    });

    expect(res.status).toBe(401);
    expect(dbContextCalls).toHaveLength(0);
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

// #4340 — routine event-log submits are counted, not audited. Only an insert
// failure or a clamped timestamp (an anomaly worth a chained record) is audited.
describe('eventlogs ingest audit (#4340)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-02T12:00:00.000Z'));
    contextDepth = 0;
    dbContextCalls.length = 0;
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('agent', { deviceId: 'dev-1', agentId: 'agent-1', orgId: ORG_ID, partnerId: 'partner-1', siteId: 'site-1', role: 'agent' } as never);
      return next();
    });
    app.route('/agents', eventLogsRoutes);
    mocks.getDeviceEventLogSettings.mockResolvedValue({ minimumLevel: 'info', rateLimitPerHour: 1000 });
    mocks.rateLimiter.mockResolvedValue({ allowed: true, remaining: 999, resetAt: new Date('2026-05-02T13:00:00.000Z') });
    mocks.getOrgForwardingConfig.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const submit = (events: unknown[]) => app.request(`/agents/${AGENT_ID}/eventlogs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });

  it('does NOT audit a clean submit — counts it in the ingest metric', async () => {
    mockDeviceLookup();
    mockInsertSuccess();

    const res = await submit([makeEvent(), makeEvent({ eventId: '4624' })]);

    expect(res.status).toBe(200);
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    expect(recordAgentIngestSubmission).toHaveBeenCalledTimes(1);
    expect(recordAgentIngestSubmission).toHaveBeenCalledWith('eventlogs', 'success');
  });

  it('does NOT audit a submit whose rows were all absorbed as duplicates', async () => {
    mockDeviceLookup();
    mockInsertAllConflicts();

    const res = await submit([makeEvent()]);

    expect(res.status).toBe(200);
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
    expect(recordAgentIngestSubmission).toHaveBeenCalledWith('eventlogs', 'success');
  });

  it('audits a submit with a clamped future timestamp', async () => {
    mockDeviceLookup();
    mockInsertSuccess();

    const res = await submit([makeEvent({ timestamp: '2026-05-02T13:00:00.000Z' }), makeEvent({ eventId: '4624' })]);

    expect(res.status).toBe(200);
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent.mock.calls[0]![1]).toMatchObject({
      orgId: ORG_ID,
      actorType: 'agent',
      action: 'agent.eventlogs.submit',
      resourceType: 'device',
      resourceId: DEVICE_ID,
      result: 'success',
      details: { submittedCount: 2, insertedCount: 2, filteredCount: 0, timestampClampedCount: 1 },
    });
    expect(recordAgentIngestSubmission).toHaveBeenCalledWith('eventlogs', 'success');
  });

  it('audits an insert failure as a failure result', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDeviceLookup();
    const returning = vi.fn().mockRejectedValue(new Error('insert failed'));
    mocks.insert.mockReturnValue({ values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockReturnValue({ returning }) }) });

    const res = await submit([makeEvent()]);

    expect(res.status).toBe(500);
    expect(mocks.writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditEvent.mock.calls[0]![1]).toMatchObject({
      action: 'agent.eventlogs.submit',
      result: 'failure',
      details: { submittedCount: 1, insertedCount: 0, filteredCount: 0 },
    });
    expect(recordAgentIngestSubmission).toHaveBeenCalledWith('eventlogs', 'failed');
    consoleError.mockRestore();
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
