import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { selectMock } = vi.hoisted(() => ({ selectMock: vi.fn() }));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions: conditions.filter(Boolean) }),
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
  inArray: (left: unknown, right: unknown) => ({ type: 'inArray', left, right }),
  isNull: (column: unknown) => ({ type: 'isNull', column }),
  or: (...conditions: unknown[]) => ({ type: 'or', conditions }),
  sql: Object.assign((strings: TemplateStringsArray) => ({ type: 'sql', text: strings.join('?') }), {
    raw: (s: string) => ({ type: 'raw', s }),
  }),
}));

vi.mock('../../db', () => ({ db: { select: selectMock } }));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  alerts: {
    deviceId: 'alerts.deviceId',
    status: 'alerts.status',
    severity: 'alerts.severity',
    topologySiteId: 'alerts.topologySiteId',
  },
  tickets: { deviceId: 'tickets.deviceId', status: 'tickets.status', deletedAt: 'tickets.deletedAt' },
}));

const ORG_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const restricted = c.req.header('x-site-restricted');
    const allowedSiteIds = restricted === 'true' ? ['site-allowed'] : restricted === 'empty' ? [] : undefined;
    c.set('auth', {
      user: { id: 'user-1' },
      orgId: ORG_ID,
      scope: 'organization',
      allowedSiteIds,
      orgCondition: (col: string) => ({ type: 'orgCondition', col }),
      canAccessOrg: () => true,
    });
    c.set('permissions', { permissions: [], allowedSiteIds });
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { DEVICES_READ: { resource: 'devices', action: 'read' } },
}));

import { attentionCountsRoutes } from './attentionCounts';

const D1 = '22222222-2222-4222-8222-222222222222';
const D2 = '33333333-3333-4333-8333-333333333333';
const D3 = '44444444-4444-4444-8444-444444444444';

function uuidFor(i: number): string {
  return `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;
}

function chainResolving(rows: unknown[]) {
  const thenable = Promise.resolve(rows);
  const chain: any = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    groupBy: vi.fn(() => chain),
    then: vi.fn(thenable.then.bind(thenable)),
  };
  return chain;
}

/** db.select() calls resolve in order: [alert rows, ticket rows]. */
function queueSelects(alertRows: unknown[], ticketRows: unknown[]) {
  const queue = [alertRows, ticketRows];
  selectMock.mockImplementation(() => chainResolving(queue.shift() ?? []));
}

/** Statements actually executed = query chains that were awaited. */
function executedStatements(): number {
  return selectMock.mock.results.filter((r) => r.value.then.mock.calls.length > 0).length;
}

describe('GET /devices/attention-counts', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', attentionCountsRoutes);
  });

  it('returns per-device open alerts by severity and open tickets in exactly two statements', async () => {
    queueSelects(
      [
        { deviceId: D1, severity: 'critical', count: '2' },
        { deviceId: D1, severity: 'low', count: 1 },
        { deviceId: D2, severity: 'high', count: '1' },
      ],
      [
        { deviceId: D1, count: '3' },
        { deviceId: D3, count: '1' },
      ],
    );

    const res = await app.request(`/devices/attention-counts?ids=${D1},${D2},${D3}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      counts: {
        [D1]: { alerts: { critical: 2, high: 0, medium: 0, low: 1, info: 0 }, tickets: 3 },
        [D2]: { alerts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, tickets: 0 },
        [D3]: { alerts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, tickets: 1 },
      },
    });
    expect(selectMock).toHaveBeenCalledTimes(2);
    expect(executedStatements()).toBe(2);
  });

  it('issues the same two statements for a full page of 100 ids', async () => {
    queueSelects([], []);
    const ids = Array.from({ length: 100 }, (_, i) => uuidFor(i));
    const res = await app.request(`/devices/attention-counts?ids=${ids.join(',')}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: {} });
    expect(executedStatements()).toBe(2);
  });

  it('scopes both statements to the requested ids, the caller-visible devices, and open states', async () => {
    queueSelects([], []);
    await app.request(`/devices/attention-counts?ids=${D1},${D2}`, { headers: { 'x-site-restricted': 'true' } });

    const [alertChain, ticketChain] = selectMock.mock.results.map((r) => r.value);

    expect(alertChain.innerJoin.mock.calls[0]![1]).toEqual({ type: 'eq', left: 'devices.id', right: 'alerts.deviceId' });
    const alertWhere = alertChain.where.mock.calls[0]![0];
    expect(alertWhere.conditions).toEqual(
      expect.arrayContaining([
        { type: 'inArray', left: 'alerts.deviceId', right: [D1, D2] },
        { type: 'inArray', left: 'alerts.status', right: ['active', 'acknowledged'] },
        // device list scope: org condition + site allowlist on the device row
        {
          type: 'and',
          conditions: [
            { type: 'orgCondition', col: 'devices.orgId' },
            { type: 'inArray', left: 'devices.siteId', right: ['site-allowed'] },
          ],
        },
        // the same topology-site gate tab-counts applies to alerts
        {
          type: 'or',
          conditions: [
            { type: 'isNull', column: 'alerts.topologySiteId' },
            { type: 'inArray', left: 'alerts.topologySiteId', right: ['site-allowed'] },
          ],
        },
      ]),
    );
    expect(alertChain.groupBy).toHaveBeenCalledWith('alerts.deviceId', 'alerts.severity');

    expect(ticketChain.innerJoin.mock.calls[0]![1]).toEqual({ type: 'eq', left: 'devices.id', right: 'tickets.deviceId' });
    const ticketWhere = ticketChain.where.mock.calls[0]![0];
    expect(ticketWhere.conditions).toEqual(
      expect.arrayContaining([
        { type: 'inArray', left: 'tickets.deviceId', right: [D1, D2] },
        // same device-list scope as the alert statement
        {
          type: 'and',
          conditions: [
            { type: 'orgCondition', col: 'devices.orgId' },
            { type: 'inArray', left: 'devices.siteId', right: ['site-allowed'] },
          ],
        },
        { type: 'isNull', column: 'tickets.deletedAt' },
        { type: 'inArray', left: 'tickets.status', right: ['new', 'open', 'pending', 'on_hold'] },
      ]),
    );
    // tickets carry no topology site, so no topology gate on that statement
    expect(ticketWhere.conditions.some((c: { type: string }) => c.type === 'or')).toBe(false);
    expect(ticketChain.groupBy).toHaveBeenCalledWith('tickets.deviceId');
  });

  it('applies no site narrowing or topology gate for an unrestricted caller', async () => {
    queueSelects([], []);
    await app.request(`/devices/attention-counts?ids=${D1}`);
    const alertWhere = selectMock.mock.results[0]!.value.where.mock.calls[0]![0];
    expect(alertWhere.conditions).toContainEqual({
      type: 'and',
      conditions: [{ type: 'orgCondition', col: 'devices.orgId' }],
    });
    expect(alertWhere.conditions.some((c: { type: string }) => c.type === 'or')).toBe(false);
  });

  it('returns 400 above 100 ids without querying', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => uuidFor(i));
    const res = await app.request(`/devices/attention-counts?ids=${ids.join(',')}`);
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed id without querying', async () => {
    const res = await app.request(`/devices/attention-counts?ids=${D1},not-a-uuid`);
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns 400 when ids is missing', async () => {
    const res = await app.request('/devices/attention-counts');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('dedupes ids and tolerates whitespace and empty entries', async () => {
    queueSelects([], []);
    await app.request(`/devices/attention-counts?ids=${D1},%20${D1},,${D2}`);
    const alertWhere = selectMock.mock.results[0]!.value.where.mock.calls[0]![0];
    expect(alertWhere.conditions).toContainEqual({ type: 'inArray', left: 'alerts.deviceId', right: [D1, D2] });
  });

  it('returns empty counts without querying for an empty id list', async () => {
    const res = await app.request('/devices/attention-counts?ids=');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: {} });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('returns empty counts without querying for an empty site allowlist', async () => {
    const res = await app.request(`/devices/attention-counts?ids=${D1}`, { headers: { 'x-site-restricted': 'empty' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ counts: {} });
    expect(selectMock).not.toHaveBeenCalled();
  });
});
