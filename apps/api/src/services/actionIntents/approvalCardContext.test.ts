/**
 * #11674 — what the chat approval card names, beyond the guardrail headline.
 *
 * `buildApprovalDescription` (aiGuardrails.ts) builds a headline from tool
 * input alone, so it can only name a ticket or a device by an id stub
 * (`ticket #2aad0601...`, `on device 8f14580d...`). The chat card resolves the
 * ticket number and the device name and swaps them in. The ticket read runs
 * with RLS bypassed (system context, like approvalDeviceName.ts), so the org
 * pin in its WHERE clause is asserted on the bound parameters, not on the
 * returned rows — see approvalDeviceName.test.ts for why.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbState = {
  whereArgs: [] as unknown[],
  rows: [] as Array<{ ticketNumber: string; subject: string; submitterName: string | null; submitterEmail: string | null; deviceId?: string | null }>,
  failWith: null as Error | null,
  systemContextLabels: [] as Array<string | undefined>,
  outsideContextCalls: 0,
};

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          dbState.whereArgs.push(condition);
          return {
            limit: async () => {
              if (dbState.failWith) throw dbState.failWith;
              return dbState.rows;
            },
          };
        },
      }),
    }),
  },
  runOutsideDbContext: <T,>(fn: () => Promise<T>) => {
    dbState.outsideContextCalls += 1;
    return fn();
  },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>, label?: string) => {
    dbState.systemContextLabels.push(label);
    return fn();
  },
}));

const captureException = vi.fn();
vi.mock('../sentry', () => ({ captureException: (e: unknown) => captureException(e) }));

const deviceInSiteScope = vi.fn(async (_auth: unknown, _deviceId: string) => true);
vi.mock('../../routes/tickets/siteScope', () => ({
  deviceInSiteScope: (auth: unknown, deviceId: string) => deviceInSiteScope(auth, deviceId),
}));

import { and, eq } from 'drizzle-orm';
import { argumentTicketId, nameApprovalCardTargets, resolveApprovalTicketContext } from './approvalCardContext';
import { tickets } from '../../db/schema';

const TICKET_ID = '2aad0601-1111-4222-8333-444455556666';
const DEVICE_ID = '8f14580d-1111-4222-8333-444455556666';
const ORG_ID = '11111111-2222-4333-8444-555566667777';
const OTHER_ORG_ID = '99999999-2222-4333-8444-555566667777';
const REACH_ORG_ID = '22222222-2222-4333-8444-555566667777';

/** A caller with no org restriction of its own (org-scope sessions often return undefined). */
const openReach = { orgCondition: () => undefined, allowedSiteIds: undefined, allowedDeviceIds: undefined } as never;

/** Every column name referenced anywhere inside a drizzle SQL condition. */
function columnNames(node: unknown): string[] {
  if (node === null || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  if ('table' in obj && typeof obj.name === 'string' && 'columnType' in obj) return [obj.name];
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) return chunks.flatMap(columnNames);
  return [];
}

function boundParams(node: unknown): unknown[] {
  if (node === null || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) return [obj.value];
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) return chunks.flatMap(boundParams);
  return [];
}

beforeEach(() => {
  dbState.whereArgs = [];
  dbState.rows = [];
  dbState.failWith = null;
  dbState.systemContextLabels = [];
  dbState.outsideContextCalls = 0;
  captureException.mockClear();
  deviceInSiteScope.mockClear();
  deviceInSiteScope.mockResolvedValue(true);
});

describe('boundParams (control for the org-pin assertion)', () => {
  it('sees both terms of an and(eq, eq) and loses one when a term is dropped', () => {
    expect(boundParams(and(eq(tickets.id, TICKET_ID), eq(tickets.orgId, ORG_ID))))
      .toEqual(expect.arrayContaining([TICKET_ID, ORG_ID]));
    expect(boundParams(eq(tickets.id, TICKET_ID))).not.toContain(ORG_ID);
  });
});

describe('resolveApprovalTicketContext', () => {
  it('pins the read to BOTH the ticket id and the org, under a fresh system context', async () => {
    dbState.rows = [{ ticketNumber: 'T-2026-0001', subject: 'X-ray workstation is really slow', submitterName: 'Dana', submitterEmail: 'dana@example.test' }];

    await resolveApprovalTicketContext(TICKET_ID, ORG_ID, openReach);

    expect(dbState.whereArgs).toHaveLength(1);
    const params = boundParams(dbState.whereArgs[0]);
    expect(params).toContain(TICKET_ID);
    expect(params).toContain(ORG_ID);
    expect(params).not.toContain(OTHER_ORG_ID);
    expect(dbState.outsideContextCalls).toBe(1);
    expect(dbState.systemContextLabels).toEqual(['actionIntents.approvalCardTicket']);
  });

  it('returns the number, subject and the requester the reply emails', async () => {
    dbState.rows = [{ ticketNumber: 'T-2026-0001', subject: 'X-ray workstation is really slow', submitterName: 'Dana', submitterEmail: 'dana@example.test' }];

    await expect(resolveApprovalTicketContext(TICKET_ID, ORG_ID, openReach)).resolves.toEqual({
      ticketNumber: 'T-2026-0001',
      subject: 'X-ray workstation is really slow',
      requesterName: 'Dana',
      requesterEmail: 'dana@example.test',
    });
  });

  it('omits requester fields the ticket does not carry', async () => {
    dbState.rows = [{ ticketNumber: 'T-2026-0002', subject: 'Printer', submitterName: null, submitterEmail: null }];

    await expect(resolveApprovalTicketContext(TICKET_ID, ORG_ID, openReach)).resolves.toEqual({
      ticketNumber: 'T-2026-0002',
      subject: 'Printer',
    });
  });

  it('resolves to nothing when the org pin matches no row', async () => {
    await expect(resolveApprovalTicketContext(TICKET_ID, ORG_ID, openReach)).resolves.toBeNull();
  });

  it('applies the caller\'s own reach: their org condition and the not-deleted filter', async () => {
    const reach = { orgCondition: () => eq(tickets.orgId, REACH_ORG_ID), allowedSiteIds: undefined, allowedDeviceIds: undefined } as never;

    await resolveApprovalTicketContext(TICKET_ID, ORG_ID, reach);

    const condition = dbState.whereArgs[0];
    expect(boundParams(condition)).toContain(REACH_ORG_ID);
    expect(columnNames(condition)).toContain('deleted_at');
  });

  it('shows nothing for a ticket whose device is outside the caller\'s site scope', async () => {
    // findTicketWithAccess (aiToolsTicketing.ts) hides it from the tool too.
    dbState.rows = [{ ticketNumber: 'T-2026-0001', subject: 'S', submitterName: null, submitterEmail: 'a@example.test', deviceId: 'dev-1' }];
    deviceInSiteScope.mockResolvedValue(false);
    const reach = { orgCondition: () => undefined, allowedSiteIds: ['site-a'], allowedDeviceIds: undefined } as never;

    await expect(resolveApprovalTicketContext(TICKET_ID, ORG_ID, reach)).resolves.toBeNull();
    expect(deviceInSiteScope).toHaveBeenCalledWith(reach, 'dev-1');
  });

  it('reports a failed read to Sentry and degrades to null instead of throwing', async () => {
    dbState.failWith = new Error('connection terminated');

    await expect(resolveApprovalTicketContext(TICKET_ID, ORG_ID, openReach)).resolves.toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe('argumentTicketId', () => {
  it('names the ticket of a manage_tickets call', () => {
    expect(argumentTicketId('manage_tickets', { action: 'comment', ticketId: TICKET_ID })).toBe(TICKET_ID);
  });

  it('ignores other tools and malformed ids, so a junk argument never reaches a uuid column', () => {
    expect(argumentTicketId('execute_command', { ticketId: TICKET_ID })).toBeNull();
    for (const bad of ['', '2aad0601', `${TICKET_ID} OR 1=1`, 42]) {
      expect(argumentTicketId('manage_tickets', { ticketId: bad })).toBeNull();
    }
    expect(argumentTicketId('manage_tickets', {})).toBeNull();
  });
});

describe('nameApprovalCardTargets', () => {
  it('replaces this ticket\'s id stub with its number', () => {
    expect(nameApprovalCardTargets(
      'Post PUBLIC comment on ticket #2aad0601... (customer-visible; emails the requester)',
      { ticketId: TICKET_ID, ticketNumber: 'T-2026-0001' },
    )).toBe('Post PUBLIC comment on ticket T-2026-0001 (customer-visible; emails the requester)');
  });

  it('replaces this device\'s id stub with its name, keeping the preposition', () => {
    expect(nameApprovalCardTargets('List services on device 8f14580d...', { deviceId: DEVICE_ID, deviceName: 'NW-RECEPTION-PC' }))
      .toBe('List services on NW-RECEPTION-PC');
    expect(nameApprovalCardTargets('Collect file from device 8f14580d...', { deviceId: DEVICE_ID, deviceName: 'NW-RECEPTION-PC' }))
      .toBe('Collect file from NW-RECEPTION-PC');
  });

  it('leaves a stub for some OTHER id untouched', () => {
    const text = 'Merge ticket #aaaaaaaa... into ticket #2aad0601...';
    expect(nameApprovalCardTargets(text, { ticketId: TICKET_ID, ticketNumber: 'T-2026-0001' }))
      .toBe('Merge ticket #aaaaaaaa... into ticket T-2026-0001');
    expect(nameApprovalCardTargets('Reboot on device aaaaaaaa...', { deviceId: DEVICE_ID, deviceName: 'PC' }))
      .toBe('Reboot on device aaaaaaaa...');
  });

  it('inserts a name containing $ literally', () => {
    expect(nameApprovalCardTargets('Reboot on device 8f14580d...', { deviceId: DEVICE_ID, deviceName: 'PC-$&-01' }))
      .toBe('Reboot on PC-$&-01');
  });

  it('is a no-op without a resolved name', () => {
    const text = 'Post internal note on ticket #2aad0601...';
    expect(nameApprovalCardTargets(text, { ticketId: TICKET_ID })).toBe(text);
    expect(nameApprovalCardTargets(text, {})).toBe(text);
  });
});
