/**
 * #10933: each route that wakes the PSA ticketing worker must reach BullMQ only
 * after the request's DB transaction has settled. Real: the routes, the admission
 * flow, the wake helpers, the instrumented queue and the #1105 tripwire (strict,
 * so a violation throws). Faked: the postgres driver, the BullMQ Queue class,
 * Redis, auth, rate limiting, audit, the alert-access helper and admission's own
 * load and insert. A `withSystemDbAccessContext` middleware stands in for the
 * transaction authMiddleware opens around a request.
 *
 * A worker woken before the commit reads the row as it was before the re-arm,
 * finds nothing due and drops the wake (the #10926 shape). `events` records the
 * order the worker would observe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
  process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
  const events: string[] = [];
  const selects: unknown[][] = [];
  const updates: unknown[][] = [];
  const depth = { value: 0 };
  function chain(rows: unknown[]) {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'returning', 'set', 'innerJoin', 'leftJoin']) {
      c[m] = () => Object.assign(Promise.resolve(rows), c);
    }
    return Object.assign(Promise.resolve(rows), c);
  }
  const tx = {
    execute: () => Promise.resolve([]),
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    select: () => chain(selects.shift() ?? []),
    update: () => {
      events.push('update');
      return chain(updates.shift() ?? []);
    },
  };
  const drizzleFactory = () => ({
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      depth.value += 1;
      try {
        return await fn(tx);
      } finally {
        depth.value -= 1;
        if (depth.value === 0) events.push('commit');
      }
    },
  });
  return {
    events,
    selects,
    updates,
    depth,
    drizzleFactory,
    add: vi.fn(async (..._args: unknown[]) => ({})),
    loadAdmission: vi.fn(),
    insertAdmission: vi.fn(),
    getAlert: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: h.drizzleFactory }));
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = h.add;
    close = vi.fn(async () => {});
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../middleware/auth', () => ({
  withAuthDbAccessContext: (_auth: unknown, fn: () => Promise<unknown>) => fn(),
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (c: { set(key: string, value: unknown): void }, next: () => Promise<void>) => {
    c.set('permissions', { allowedSiteIds: undefined });
    return next();
  },
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../middleware/userRateLimit', () => ({
  userRateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: h.audit,
  writeAuditEventAsync: vi.fn(),
  requestLikeFromSnapshot: vi.fn(),
}));
vi.mock('./alerts/helpers', () => ({ getAlertWithOrgCheck: h.getAlert }));
vi.mock('../services/psaAlertTicketing/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/psaAlertTicketing/storage')>()),
  // Admission's own reads/writes are not the subject. wakeAlertMappings stays real.
  loadAdmission: h.loadAdmission,
  insertAdmission: h.insertAdmission,
}));

import { hasDbAccessContext, withSystemDbAccessContext } from '../db';
import { alertPsaTicketRoutes } from './alerts/alertPsaTicket';
import { psaAlertTicketingRoutes, psaTicketMappingActionRoutes } from './psaAlertTicketing';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const ALERT_ID = '33333333-3333-4333-8333-333333333333';
const MAPPING_ID = '55555555-5555-4555-8555-555555555555';

const AUTH = {
  scope: 'partner',
  partnerId: PARTNER_ID,
  partnerOrgAccess: 'all',
  orgId: null,
  user: { id: 'user-1', email: 'admin@example.test' },
  canAccessOrg: () => true,
  accessibleOrgIds: [],
  orgCondition: () => undefined,
};
const CONNECTION = {
  id: CONNECTION_ID, orgId: null, partnerId: PARTNER_ID, provider: 'connectwise', name: 'Manage',
  credentials: { encrypted: 'x' }, alertTicketing: null, alertTicketingRev: 3,
  alertTicketingEnabledAt: null, alertTicketingPausedReason: null, alertTicketingPausedAt: null,
};
const PARTNER_BINDING = { serviceManagementMode: 'external', serviceManagementPsaConnectionId: CONNECTION_ID };

function appUnderRequestTransaction(outcome: 'commit' | 'rollback') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, AUTH as never);
    await withSystemDbAccessContext(async () => {
      await next();
      h.events.push('handler-returned');
      if (outcome === 'rollback') throw new Error('request transaction rolled back');
    }).catch((error: unknown) => {
      if (outcome !== 'rollback') throw error;
    });
  });
  app.route('/alerts', alertPsaTicketRoutes);
  app.route('/psa/connections', psaAlertTicketingRoutes);
  app.route('/psa', psaTicketMappingActionRoutes);
  return app;
}

const post = (path: string, body?: unknown, outcome: 'commit' | 'rollback' = 'commit') => appUnderRequestTransaction(outcome).request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('PSA ticketing wakes enqueue after the request transaction (#10933)', () => {
  const contexts: boolean[] = [];

  beforeEach(() => {
    process.env.DB_CONTEXT_TRIPWIRE_STRICT = '1';
    h.events.length = 0;
    h.selects.length = 0;
    h.updates.length = 0;
    h.depth.value = 0;
    contexts.length = 0;
    vi.clearAllMocks();
    h.add.mockImplementation(async () => {
      h.events.push('add');
      contexts.push(hasDbAccessContext());
      return {};
    });
  });
  afterEach(() => {
    delete process.env.DB_CONTEXT_TRIPWIRE_STRICT;
  });

  function expectWokeOnceAfterCommit() {
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(h.add.mock.calls[0]?.[1]).toEqual({ mappingId: MAPPING_ID, op: 'create' });
    expect(contexts).toEqual([false]);
    const commit = h.events.lastIndexOf('commit');
    expect(h.events.indexOf('handler-returned')).toBeLessThan(commit);
    expect(commit).toBeLessThan(h.events.indexOf('add'));
  }

  it('POST /alerts/:id/psa-ticket', async () => {
    h.getAlert.mockResolvedValue({ id: ALERT_ID, orgId: 'org' });
    h.loadAdmission.mockResolvedValue({
      alert: { id: ALERT_ID, orgId: 'org', status: 'active' },
      target: { connectionId: CONNECTION_ID, config: {}, rev: 3, enabledAt: new Date() },
    });
    h.insertAdmission.mockResolvedValue(MAPPING_ID);
    const binding = { mode: 'external', connectionId: CONNECTION_ID };
    h.selects.push(
      [binding], // route: binding before admission
      [{ id: MAPPING_ID }], // wakeAlertMappings
      [{ createState: 'never_attempted', status: 'active', acknowledgedAt: null }], // wakeTicketMapping
      [binding], // route: binding after admission
      [{ id: MAPPING_ID, alertId: ALERT_ID }], // route: mapping returned to the caller
    );

    const res = await post(`/alerts/${ALERT_ID}/psa-ticket`);
    await settle();

    expect(res.status).toBe(202);
    expectWokeOnceAfterCommit();
  });

  it('POST /psa/ticket-mappings/:id/create-anyway', async () => {
    h.selects.push(
      [{ id: MAPPING_ID, connectionId: CONNECTION_ID, createState: 'needs_attention', createSnapshot: {} }],
      [CONNECTION],
      [PARTNER_BINDING],
    );
    h.updates.push([{ id: MAPPING_ID, connectionId: CONNECTION_ID, createState: 'never_attempted' }]);

    const res = await post(`/psa/ticket-mappings/${MAPPING_ID}/create-anyway`);
    await settle();

    expect(res.status).toBe(200);
    expectWokeOnceAfterCommit();
    expect(h.events.indexOf('update')).toBeLessThan(h.events.lastIndexOf('commit'));
  });

  it('POST /psa/connections/:id/alert-ticketing/redrive', async () => {
    h.selects.push([CONNECTION], [PARTNER_BINDING]);
    h.updates.push([{ id: MAPPING_ID }]);

    const res = await post(`/psa/connections/${CONNECTION_ID}/alert-ticketing/redrive`, { states: ['failed'] });
    await settle();

    expect(res.status).toBe(200);
    expectWokeOnceAfterCommit();
    expect(h.events.indexOf('update')).toBeLessThan(h.events.lastIndexOf('commit'));
  });

  // The re-arm rolled back, so there is nothing to announce. The status and the
  // recorded update prove each route got as far as registering its wake.
  it('a re-drive whose request transaction rolls back enqueues nothing', async () => {
    h.selects.push([CONNECTION], [PARTNER_BINDING]);
    h.updates.push([{ id: MAPPING_ID }]);

    const res = await post(`/psa/connections/${CONNECTION_ID}/alert-ticketing/redrive`, { states: ['failed'] }, 'rollback');
    await settle();

    expect(res.status).toBe(200);
    expect(h.events).toContain('update');
    expect(h.add).not.toHaveBeenCalled();
  });

  it('a create-anyway whose request transaction rolls back enqueues nothing', async () => {
    h.selects.push(
      [{ id: MAPPING_ID, connectionId: CONNECTION_ID, createState: 'needs_attention', createSnapshot: {} }],
      [CONNECTION],
      [PARTNER_BINDING],
    );
    h.updates.push([{ id: MAPPING_ID, connectionId: CONNECTION_ID, createState: 'never_attempted' }]);

    const res = await post(`/psa/ticket-mappings/${MAPPING_ID}/create-anyway`, undefined, 'rollback');
    await settle();

    expect(res.status).toBe(200);
    expect(h.events).toContain('update');
    expect(h.add).not.toHaveBeenCalled();
  });
});
