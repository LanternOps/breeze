import { describe, expect, it, vi } from 'vitest';
import { executeTicketing, type TicketingContext, type TicketingDeps } from './execution';
import { nextOperation } from './stateMachine';
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
describe('leased PSA effects', () => {
  it('timeout → adopt → resolve → close makes exactly one create call', async () => {
    const f = harness(); f.adapter.createAlertTicket.mockRejectedValueOnce(adapterError('unknown_outcome'));
    await f.run(); expect(f.ctx.mapping.createState).toBe('create_outcome_unknown');
    f.advance(60000); await f.run();
    f.ctx.alert!.status = 'resolved'; f.ctx.alert!.resolvedAt = f.now(); await f.run();
    expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
    expect(f.adapter.findTicketsByMarker).toHaveBeenCalledTimes(1);
    expect(f.adapter.closeTicket).toHaveBeenCalledTimes(1);
  });
  it('adopts the oldest of several matches and records the rest', async () => {
    const f = harness(); f.ctx.mapping.createState = 'create_outcome_unknown'; f.ctx.mapping.createSnapshot = { ...f.ctx.snapshot, unknownDeadline: new Date(start.getTime()+7200000).toISOString() };
    f.adapter.findTicketsByMarker.mockResolvedValue([{ ...ref, ticketId: '20', createdAt: '2026-10-31T13:00:00Z' }, ref]);
    await f.run(); expect(f.ctx.mapping.externalTicketId).toBe('10');
    expect(f.ctx.mapping.createSnapshot).toMatchObject({ duplicateTicketIds: ['20'] });
    expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
  });
  it('never rePOSTs when the two-hour lookup window expires', async () => {
    const f = harness(); f.adapter.createAlertTicket.mockRejectedValueOnce(adapterError('unknown_outcome'));
    await f.run(); f.adapter.findTicketsByMarker.mockResolvedValue([]); f.advance(7200001); await f.run();
    expect(f.ctx.mapping.createState).toBe('needs_attention'); expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
  });
  it('a create outliving its lease cannot write back or be POSTed by a second worker', async () => {
    const f = harness(); let finish!: (value: typeof ref) => void;
    f.adapter.createAlertTicket.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.run(); await vi.waitFor(() => expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1));
    f.advance(61000); f.adapter.findTicketsByMarker.mockResolvedValue([]); await f.run(); finish(ref); await first;
    expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
    expect(f.ctx.mapping.createState).toBe('create_outcome_unknown');
  });
  it('a deleted alert/mapping is a no-op', async () => {
    const f = harness(); vi.mocked(f.deps.load).mockResolvedValue(null); await f.run();
    expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
  });
  it('resolved before first create skips with zero calls; unknown creates look up first', async () => {
    const f = harness(); f.ctx.alert!.status = 'resolved'; await f.run();
    expect(f.ctx.mapping.createState).toBe('skipped_resolved_before_create'); expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
    f.ctx.mapping.createState = 'create_outcome_unknown'; f.ctx.mapping.createSnapshot = f.ctx.snapshot; await f.run();
    expect(f.adapter.findTicketsByMarker).toHaveBeenCalledTimes(1);
  });
  it('duplicate acknowledgement posts one note; uncertain notes are never rePOSTed', async () => {
    const f = harness(); await f.run(); f.ctx.alert!.acknowledgedAt = start;
    await f.run(); await f.run(); expect(f.adapter.addNote).toHaveBeenCalledTimes(1);
    const g = harness(); await g.run(); g.ctx.alert!.acknowledgedAt = start;
    g.adapter.addNote.mockRejectedValueOnce(adapterError('unknown_outcome')); await g.run(); g.advance(100000); await g.run();
    expect(g.adapter.addNote).toHaveBeenCalledTimes(1); expect(g.ctx.mapping.noteState).toBe('outcome_unknown');
  });
  it('resolve with closeOnResolve off posts a resolve note once', async () => {
    const f = harness(); f.ctx.snapshot.closeOnResolve = false; await f.run(); f.ctx.alert!.status = 'resolved';
    await f.run(); await f.run(); expect(f.adapter.addNote).toHaveBeenCalledTimes(1); expect(f.adapter.closeTicket).not.toHaveBeenCalled();
  });
  it('honors 429 Retry-After', async () => {
    const f = harness(); f.adapter.createAlertTicket.mockRejectedValueOnce(adapterError('rate_limited')); await f.run();
    expect(f.ctx.mapping.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(start.getTime()+30000);
    await f.run(); expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
  });
  it('auth pauses a connection and remaining jobs wait', async () => {
    const f = harness(); f.adapter.createAlertTicket.mockRejectedValueOnce(adapterError('auth')); await f.run(); f.advance(60000); await f.run();
    expect(f.deps.pause).toHaveBeenCalledTimes(1); expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
  });
  it('disable/rebind after create still closes on the pinned connection/snapshot', async () => {
    const f = harness(); await f.run(); f.ctx.canCreate = false; f.ctx.snapshot.closedStatusId = 99;
    f.ctx.alert!.status = 'resolved'; await f.run(); expect(f.adapter.closeTicket).toHaveBeenCalledWith('10', 3);
  });
  it.each(['create', 'note', 'close'] as const)('%s fails after its fixed 24/72 hour deadline', async (op) => {
    const f = harness();
    if (op !== 'create') { await f.run(); f.ctx.alert!.acknowledgedAt = start; if (op==='close') { f.ctx.alert!.status='resolved'; f.ctx.alert!.resolvedAt=start; } }
    f.advance((op==='close' ? 72 : 24)*3600000+1); await f.run();
    expect(op==='create' ? f.ctx.mapping.createState : op==='close' ? f.ctx.mapping.closeState : f.ctx.mapping.noteState).toBe('failed');
    expect(f.adapter.addNote).not.toHaveBeenCalled(); expect(f.adapter.closeTicket).not.toHaveBeenCalled();
  });
  it.each([[[]], [['1','2']]])('company resolution fails closed for %j', async (companies) => {
    const f = harness(); f.ctx.companyIds = companies; await f.run();
    expect(f.ctx.mapping.createState).toBe(companies.length ? 'skipped_ambiguous_company' : 'skipped_no_company');
    expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
  });
  it('state machine refuses early wake and live leases', () => {
    const f = harness(); f.ctx.mapping.nextAttemptAt=new Date(start.getTime()+1000);
    expect(nextOperation(f.ctx.mapping,f.ctx.alert,start)).toBe('none');
    f.ctx.mapping.nextAttemptAt=null; f.ctx.mapping.leaseUntil=new Date(start.getTime()+1000);
    expect(nextOperation(f.ctx.mapping,f.ctx.alert,start)).toBe('none');
  });
});
export { harness };

import { psaTicketingJobDataSchema } from '../../jobs/queueSchemas';
describe('PSA queue boundary', () => {
  it('only accepts a mapping UUID and an operation hint', () => {
    const data = { mappingId: '11111111-1111-4111-8111-111111111111', op: 'create' };
    expect(psaTicketingJobDataSchema.safeParse(data).success).toBe(true);
    expect(psaTicketingJobDataSchema.safeParse({ ...data, credentials: 'secret' }).success).toBe(false);
    expect(psaTicketingJobDataSchema.safeParse({ ...data, mappingId: 'bad' }).success).toBe(false);
    expect(psaTicketingJobDataSchema.safeParse({ ...data, op: 'delete' }).success).toBe(false);
  });
});
