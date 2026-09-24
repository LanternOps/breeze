import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * manage_tickets — EXACT-DEVICE axis (#6086 finding 6).
 *
 * A device-bound preconfigured agent run carries `auth.allowedDeviceIds`
 * (+ a site axis); a device-LESS analysis run carries `allowedDeviceIds` with
 * NO `allowedSiteIds`. Ticket access was decided by the site-only
 * `deviceInSiteScope`, so both shapes could read and mutate a ticket linked to
 * a SIBLING device in the same site. These tests pin the device axis on the
 * by-id path (findTicketWithAccess), the list query, and link_device.
 *
 * Carve-out: a ticket with NO linked device is not device-attributable and
 * must stay reachable for every device-bound run.
 *
 * The REAL routes/tickets/siteScope module is exercised here (not a mock).
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./ticketChecklistService', () => ({
  listChecklist: vi.fn(async () => ({ done: 0, total: 0, items: [] })),
}));
vi.mock('./ticketService', () => ({
  createTicket: vi.fn(async () => ({ id: 't-new' })),
  changeTicketStatus: vi.fn(async () => ({ id: 't1', status: 'resolved' })),
  assignTicket: vi.fn(async () => ({ id: 't1', assignedTo: 'u2' })),
  addTicketComment: vi.fn(async () => ({ comment: { id: 'c1' } })),
  createTicketFromAlert: vi.fn(async () => ({ id: 't-from-alert' })),
  // link_device revalidates the retained assignee after moving a ticket's
  // device scope (#5551 partner-drift fix) — a no-op stub is enough here
  // since these tests only assert on the link_device response itself.
  revalidateTicketAssignee: vi.fn(async () => ({ id: 't1' })),
}));

import { db } from '../db';
import * as ticketService from './ticketService';
import { registerTicketingTools } from './aiToolsTicketing';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };

const whereCalls: unknown[] = [];

/** Chainable, thenable fake query builder resolving to `rows`. */
function chain(rows: unknown[]): any {
  const self: any = {
    from: () => self,
    leftJoin: () => self,
    innerJoin: () => self,
    where: (cond: unknown) => { whereCalls.push(cond); return self; },
    orderBy: () => self,
    set: () => self,
    returning: () => Promise.resolve(rows),
    limit: () => self,
    offset: () => Promise.resolve(rows),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return self;
}

/**
 * Collect every bound parameter value reachable from a drizzle SQL condition.
 * (A plain JSON.stringify throws — drizzle columns hold a circular ref to
 * their table.)
 */
function paramValues(node: unknown, seen = new WeakSet<object>()): string[] {
  if (node === null || typeof node !== 'object') return [];
  if (seen.has(node as object)) return [];
  seen.add(node as object);
  const record = node as Record<string, unknown>;
  // Don't descend into column/table objects (circular, and their `name` is not
  // a bound parameter).
  if ('columnType' in record || 'dataType' in record) return [];
  const out: string[] = [];
  if (typeof record.value === 'string' && !('value' in record && Array.isArray(record.queryChunks))) {
    out.push(record.value);
  }
  for (const key of Object.keys(record)) {
    if (key === 'table') continue;
    const child = record[key];
    if (Array.isArray(child)) for (const c of child) out.push(...paramValues(c, seen));
    else if (child && typeof child === 'object') out.push(...paramValues(child, seen));
  }
  return out;
}

/** Queue of select() results, consumed in call order; last one repeats. */
function queueSelect(...results: unknown[][]) {
  let i = 0;
  mockDb.select.mockImplementation(() => chain(results[Math.min(i++, results.length - 1)]!));
}

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerTicketingTools(reg);
  return reg.get(name)!.handler;
}
const handler = () => handlerFor('manage_tickets');

function makeAuth(opts: { allowedDeviceIds?: string[]; allowedSiteIds?: string[] }): AuthContext {
  const { allowedDeviceIds, allowedSiteIds } = opts;
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    principal: { kind: 'user', userId: 'u1' },
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: allowedSiteIds
      ? (s: string | null) => !!s && allowedSiteIds.includes(s)
      : undefined,
  } as unknown as AuthContext;
}

/** Device-bound run: exact device + its site. */
const deviceBound = () => makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] });
/** Device-LESS analysis run: exact device, NO site axis. */
const deviceLess = () => makeAuth({ allowedDeviceIds: ['dev-1'] });
const unrestricted = () => makeAuth({});

beforeEach(() => {
  vi.clearAllMocks();
  whereCalls.length = 0;
});

describe('manage_tickets by-id — exact-device axis (device-bound run)', () => {
  it('get DENIES a ticket linked to a sibling device in the same site', async () => {
    // ticket load, then (pre-fix) the device site load — same site, so the
    // site-only gate passes and the sibling device leaks.
    queueSelect([{ id: 't1', orgId: 'org-1', deviceId: 'dev-2' }], [{ siteId: 'site-1' }]);
    const r = await handler()({ action: 'get', ticketId: 't1' }, deviceBound());
    expect(JSON.parse(r).error).toBe('Ticket not found');
  });

  it('update_status DENIES and does not mutate a sibling-device ticket', async () => {
    queueSelect([{ id: 't1', orgId: 'org-1', deviceId: 'dev-2' }], [{ siteId: 'site-1' }]);
    const r = await handler()(
      { action: 'update_status', ticketId: 't1', status: 'resolved', resolutionNote: 'done' },
      deviceBound()
    );
    expect(JSON.parse(r).error).toBe('Ticket not found');
    expect(ticketService.changeTicketStatus).not.toHaveBeenCalled();
  });

  it('get ALLOWS the run’s own device ticket', async () => {
    queueSelect([{ id: 't1', orgId: 'org-1', deviceId: 'dev-1' }], [{ siteId: 'site-1' }]);
    const parsed = JSON.parse(await handler()({ action: 'get', ticketId: 't1' }, deviceBound()));
    expect(parsed.error).toBeUndefined();
    expect(parsed.ticket.id).toBe('t1');
  });

  it('update_status ALLOWS the run’s own device ticket', async () => {
    queueSelect([{ id: 't1', orgId: 'org-1', deviceId: 'dev-1' }], [{ siteId: 'site-1' }]);
    const r = await handler()(
      { action: 'update_status', ticketId: 't1', status: 'resolved', resolutionNote: 'done' },
      deviceBound()
    );
    expect(JSON.parse(r).error).toBeUndefined();
    expect(ticketService.changeTicketStatus).toHaveBeenCalled();
  });

  it('get ALLOWS a ticket with NO linked device (carve-out)', async () => {
    queueSelect([{ id: 't1', orgId: 'org-1', deviceId: null }]);
    const parsed = JSON.parse(await handler()({ action: 'get', ticketId: 't1' }, deviceBound()));
    expect(parsed.error).toBeUndefined();
    expect(parsed.ticket.id).toBe('t1');
  });
});

describe('manage_tickets by-id — exact-device axis (device-LESS analysis run)', () => {
  it('get DENIES the sibling-device ticket even with no site axis', async () => {
    queueSelect([{ id: 't1', orgId: 'org-1', deviceId: 'dev-2' }], [{ siteId: 'site-1' }]);
    const r = await handler()({ action: 'get', ticketId: 't1' }, deviceLess());
    expect(JSON.parse(r).error).toBe('Ticket not found');
  });

  it('get ALLOWS its own device and a deviceless ticket', async () => {
    queueSelect([{ id: 't1', orgId: 'org-1', deviceId: 'dev-1' }]);
    expect(JSON.parse(await handler()({ action: 'get', ticketId: 't1' }, deviceLess())).ticket.id).toBe('t1');
    queueSelect([{ id: 't2', orgId: 'org-1', deviceId: null }]);
    expect(JSON.parse(await handler()({ action: 'get', ticketId: 't2' }, deviceLess())).ticket.id).toBe('t2');
  });
});

describe('manage_tickets list — exact-device axis', () => {
  it('narrows the list query to the allowed device ids (device-bound run)', async () => {
    queueSelect([]);
    await handler()({ action: 'list' }, deviceBound());
    expect(paramValues(whereCalls.at(-1))).toContain('dev-1');
  });

  it('narrows the list query for the device-LESS shape too', async () => {
    queueSelect([]);
    await handler()({ action: 'list' }, deviceLess());
    expect(paramValues(whereCalls.at(-1))).toContain('dev-1');
  });

  it('adds no device narrowing for an unrestricted caller', async () => {
    queueSelect([]);
    await handler()({ action: 'list' }, unrestricted());
    expect(paramValues(whereCalls.at(-1))).not.toContain('dev-1');
  });
});

describe('manage_tickets link_device — exact-device axis', () => {
  it('REFUSES to link a sibling device matched by hostname', async () => {
    // 1: ticket load (deviceless ticket → carve-out allows it)
    // 2: identity match → dev-2
    // 3: (if reached) device site load
    queueSelect(
      [{ id: 't1', orgId: 'org-1', deviceId: null }],
      [{ id: 'dev-2' }],
      [{ siteId: 'site-1' }],
    );
    mockDb.update.mockImplementation(() => chain([{ id: 't1' }]));
    const parsed = JSON.parse(await handler()(
      { action: 'link_device', ticketId: 't1', hostname: 'SIBLING-PC' },
      deviceBound()
    ));
    expect(parsed.linked).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('REFUSES the sibling device for the device-LESS shape too', async () => {
    queueSelect([{ id: 't1', orgId: 'org-1', deviceId: null }], [{ id: 'dev-2' }]);
    mockDb.update.mockImplementation(() => chain([{ id: 't1' }]));
    const parsed = JSON.parse(await handler()(
      { action: 'link_device', ticketId: 't1', serial: 'SN-SIBLING' },
      deviceLess()
    ));
    expect(parsed.linked).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('still LINKS the run’s own device', async () => {
    queueSelect(
      [{ id: 't1', orgId: 'org-1', deviceId: null }],
      [{ id: 'dev-1' }],
      [{ siteId: 'site-1' }],
    );
    mockDb.update.mockImplementation(() => chain([{ id: 't1' }]));
    const parsed = JSON.parse(await handler()(
      { action: 'link_device', ticketId: 't1', hostname: 'OWN-PC' },
      deviceBound()
    ));
    expect(parsed.linked).toBe(true);
    expect(parsed.deviceId).toBe('dev-1');
  });

  it('links normally for an unrestricted caller', async () => {
    queueSelect([{ id: 't1', orgId: 'org-1', deviceId: null }], [{ id: 'dev-9' }]);
    mockDb.update.mockImplementation(() => chain([{ id: 't1' }]));
    const parsed = JSON.parse(await handler()(
      { action: 'link_device', ticketId: 't1', hostname: 'ANY-PC' },
      unrestricted()
    ));
    expect(parsed.linked).toBe(true);
    expect(parsed.deviceId).toBe('dev-9');
  });
});

describe('manage_tickets — unrestricted caller unaffected on the by-id path', () => {
  it('get succeeds for any device-bound ticket', async () => {
    queueSelect([{ id: 't1', orgId: 'org-1', deviceId: 'dev-2' }]);
    const parsed = JSON.parse(await handler()({ action: 'get', ticketId: 't1' }, unrestricted()));
    expect(parsed.error).toBeUndefined();
    expect(parsed.ticket.id).toBe('t1');
  });
});

/**
 * #6096 I6 — the ticketing copy of `findAlertWithAccess` diverged from the
 * corrected one in aiToolsAlerts.ts: its `alert.deviceId && …` short-circuit
 * waved a device-LESS (org-wide) alert straight through for a device-bound
 * run. An org-wide alert is attributable to NONE of the run's devices, so it
 * must be denied — unlike a device-less TICKET, which stays reachable.
 */
describe('manage_tickets alert path — exact-device axis', () => {
  const fromAlert = (auth: AuthContext) =>
    handler()({ action: 'create_from_alert', alertId: 'a1' }, auth);

  it('DENIES a device-LESS (org-wide) alert for a device-bound run', async () => {
    queueSelect([{ id: 'a1', orgId: 'org-1', deviceId: null }]);
    expect(JSON.parse(await fromAlert(deviceBound())).error).toBe('Alert not found');
    expect(ticketService.createTicketFromAlert).not.toHaveBeenCalled();
  });

  it('DENIES a device-LESS alert for the device-LESS analysis shape too', async () => {
    queueSelect([{ id: 'a1', orgId: 'org-1', deviceId: null }]);
    expect(JSON.parse(await fromAlert(deviceLess())).error).toBe('Alert not found');
    expect(ticketService.createTicketFromAlert).not.toHaveBeenCalled();
  });

  it('DENIES a sibling-device alert in the same site', async () => {
    queueSelect([{ id: 'a1', orgId: 'org-1', deviceId: 'dev-2' }], [{ siteId: 'site-1' }]);
    expect(JSON.parse(await fromAlert(deviceBound())).error).toBe('Alert not found');
  });

  it('ALLOWS an alert on the run’s own device', async () => {
    queueSelect([{ id: 'a1', orgId: 'org-1', deviceId: 'dev-1' }], [{ siteId: 'site-1' }]);
    const parsed = JSON.parse(await fromAlert(deviceBound()));
    expect(parsed.error).toBeUndefined();
    expect(ticketService.createTicketFromAlert).toHaveBeenCalled();
  });

  it('ALLOWS an org-wide alert for an unrestricted caller (no regression)', async () => {
    queueSelect([{ id: 'a1', orgId: 'org-1', deviceId: null }]);
    const parsed = JSON.parse(await fromAlert(unrestricted()));
    expect(parsed.error).toBeUndefined();
  });
});
