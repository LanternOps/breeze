import { vi } from 'vitest';
import { executeTicketing, type TicketingContext, type TicketingDeps } from './execution';
import { PsaAdapterError } from '../psa/types';
const start = new Date('2026-10-31T12:00:00Z');
const ref = { ticketId: '10', ticketNumber: '10', externalUrl: null, createdAt: start.toISOString() };
function adapterError(errorClass: 'unknown_outcome' | 'rate_limited' | 'auth' | 'transient' | 'rejected') {
  return new PsaAdapterError({ provider: 'connectwise', errorClass, httpStatus: 500, retryAfterMs: 30000, message: 'Safe adapter error', bodySnippet: 'SECRET BODY' });
}
function harness() {
  let now = start;
  const adapter = { createAlertTicket: vi.fn(async () => ref), findTicketsByMarker: vi.fn(async () => [ref]),
    closeTicket: vi.fn(async () => {}), addNote: vi.fn(async () => {}) };
  const ctx = { mapping: { id: 'mapping', connectionId: 'connection', alertId: 'alert', createState: 'never_attempted',
    closeState: 'none', noteState: 'none', attempts: 0, nextAttemptAt: null, deadlineAt: new Date(start.getTime() + 86400000),
    leaseToken: null, leaseUntil: null, createSnapshot: null, externalTicketId: null, createdAt: start },
    alert: { id: 'alert', status: 'active', acknowledgedAt: null, resolvedAt: null },
    connection: { id: 'connection', partnerId: 'partner', provider: 'connectwise', alertTicketingPausedReason: null },
    canCreate: true, companyIds: ['1'], snapshot: { input: { alertId: 'alert', summary: 'Alert', description: 'Message', companyId: '1', boardId: 1, statusId: 2 },
      closeOnResolve: true, noteOnAcknowledge: true, closedStatusId: 3, hourlyCreateCap: 100 }, adapter } as unknown as TicketingContext;
  const deps: TicketingDeps = {
    load: vi.fn(async () => ctx),
    claim: vi.fn(async (expected, token, changes) => {
      if (ctx.mapping.leaseToken !== expected.leaseToken || (ctx.mapping.leaseUntil && ctx.mapping.leaseUntil > now)) return false;
      Object.assign(ctx.mapping, changes, { leaseToken: token, leaseUntil: new Date(now.getTime() + 60000) }); return true;
    }),
    save: vi.fn(async (_id, token, changes) => {
      if (ctx.mapping.leaseToken !== token || !ctx.mapping.leaseUntil || ctx.mapping.leaseUntil <= now) return false;
      Object.assign(ctx.mapping, changes, { leaseToken: null, leaseUntil: null }); return true;
    }),
    pause: vi.fn(async () => { ctx.connection.alertTicketingPausedReason = 'auth'; }),
    wake: vi.fn(async () => {}), report: vi.fn(),
  };
  return { ctx, adapter, deps, run: () => executeTicketing('mapping', deps, now), advance: (ms: number) => { now = new Date(now.getTime() + ms); }, now: () => now };
}

export { harness, start, ref, adapterError };
