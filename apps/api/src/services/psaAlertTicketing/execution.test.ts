import { describe, expect, it, vi } from 'vitest';
import { nextOperation } from './stateMachine';
import { harness, start, ref, adapterError } from './testHarness';
describe('leased PSA effects', () => {
  it('timeout → adopt → resolve → close makes exactly one create call', async () => {
    const f = harness();
    f.adapter.createAlertTicket.mockRejectedValueOnce(adapterError('unknown_outcome'));
    await f.run();
    expect(f.ctx.mapping.createState).toBe('create_outcome_unknown');
    f.advance(60000);
    await f.run();
    f.ctx.alert!.status = 'resolved';
    f.ctx.alert!.resolvedAt = f.now();
    await f.run();
    expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
    expect(f.adapter.findTicketsByMarker).toHaveBeenCalledTimes(1);
    expect(f.adapter.closeTicket).toHaveBeenCalledTimes(1);
  });
  it('adopts the oldest of several matches and records the rest', async () => {
    const f = harness();
    f.ctx.mapping.createState = 'create_outcome_unknown';
    f.ctx.mapping.createSnapshot = {
      ...f.ctx.snapshot,
      unknownDeadline: new Date(start.getTime() + 7200000).toISOString(),
    };
    f.adapter.findTicketsByMarker.mockResolvedValue([
      { ...ref, ticketId: '20', createdAt: '2026-10-31T13:00:00Z' },
      ref,
    ]);
    await f.run();
    expect(f.ctx.mapping.externalTicketId).toBe('10');
    expect(f.ctx.mapping.createSnapshot).toMatchObject({ duplicateTicketIds: ['20'] });
    expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
  });
  it('never rePOSTs when the two-hour lookup window expires', async () => {
    const f = harness();
    f.adapter.createAlertTicket.mockRejectedValueOnce(adapterError('unknown_outcome'));
    await f.run();
    f.adapter.findTicketsByMarker.mockResolvedValue([]);
    f.advance(7200001);
    await f.run();
    expect(f.ctx.mapping.createState).toBe('needs_attention');
    expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
  });
  it('a create outliving its lease cannot write back or be POSTed by a second worker', async () => {
    const f = harness();
    let finish!: (value: typeof ref) => void;
    f.adapter.createAlertTicket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = f.run();
    await vi.waitFor(() => expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1));
    f.advance(61000);
    f.adapter.findTicketsByMarker.mockResolvedValue([]);
    await f.run();
    finish(ref);
    await first;
    expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
    expect(f.ctx.mapping.createState).toBe('create_outcome_unknown');
  });
  it('a deleted alert/mapping is a no-op', async () => {
    const f = harness();
    vi.mocked(f.deps.load).mockResolvedValue(null);
    await f.run();
    expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
  });
  it('resolved before first create skips with zero calls; unknown creates look up first', async () => {
    const f = harness();
    f.ctx.alert!.status = 'resolved';
    await f.run();
    expect(f.ctx.mapping.createState).toBe('skipped_resolved_before_create');
    expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
    f.ctx.mapping.createState = 'create_outcome_unknown';
    f.ctx.mapping.createSnapshot = f.ctx.snapshot;
    await f.run();
    expect(f.adapter.findTicketsByMarker).toHaveBeenCalledTimes(1);
  });
  it('duplicate acknowledgement posts one note; uncertain notes are never rePOSTed', async () => {
    const f = harness();
    await f.run();
    f.ctx.alert!.acknowledgedAt = start;
    await f.run();
    await f.run();
    expect(f.adapter.addNote).toHaveBeenCalledTimes(1);
    const g = harness();
    await g.run();
    g.ctx.alert!.acknowledgedAt = start;
    g.adapter.addNote.mockRejectedValueOnce(adapterError('unknown_outcome'));
    await g.run();
    g.advance(100000);
    await g.run();
    expect(g.adapter.addNote).toHaveBeenCalledTimes(1);
    expect(g.ctx.mapping.noteState).toBe('outcome_unknown');
  });
  it('resolve with closeOnResolve off posts a resolve note once', async () => {
    const f = harness();
    f.ctx.snapshot.closeOnResolve = false;
    await f.run();
    f.ctx.alert!.status = 'resolved';
    await f.run();
    await f.run();
    expect(f.adapter.addNote).toHaveBeenCalledTimes(1);
    expect(f.adapter.closeTicket).not.toHaveBeenCalled();
  });
  it('honors 429 Retry-After', async () => {
    const f = harness();
    f.adapter.createAlertTicket.mockRejectedValueOnce(adapterError('rate_limited', 90000));
    await f.run();
    expect(f.ctx.mapping.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(start.getTime() + 90000);
    await f.run();
    expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
  });
  it('auth pauses a connection and remaining jobs wait', async () => {
    const f = harness();
    f.adapter.createAlertTicket.mockRejectedValueOnce(adapterError('auth'));
    await f.run();
    f.advance(60000);
    await f.run();
    expect(f.deps.pause).toHaveBeenCalledTimes(1);
    expect(f.ctx.mapping.lastErrorClass).toBe('auth');
    expect(f.ctx.mapping.createState).toBe('never_attempted');
    expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
  });
  it('disable/rebind after create still closes on the pinned connection/snapshot', async () => {
    const f = harness();
    await f.run();
    f.ctx.canCreate = false;
    f.ctx.snapshot.closedStatusId = 99;
    f.ctx.alert!.status = 'resolved';
    await f.run();
    expect(f.adapter.closeTicket).toHaveBeenCalledWith('10', 3);
  });
  it.each(['create', 'note', 'close'] as const)(
    '%s fails after its fixed 24/72 hour deadline',
    async (op) => {
      const f = harness();
      if (op !== 'create') {
        await f.run();
        f.ctx.alert!.acknowledgedAt = start;
        if (op === 'close') {
          f.ctx.alert!.status = 'resolved';
          f.ctx.alert!.resolvedAt = start;
        }
      }
      f.advance((op === 'close' ? 72 : 24) * 3600000 + 1);
      await f.run();
      expect(
        op === 'create'
          ? f.ctx.mapping.createState
          : op === 'close'
            ? f.ctx.mapping.closeState
            : f.ctx.mapping.noteState
      ).toBe('failed');
      expect(f.adapter.addNote).not.toHaveBeenCalled();
      expect(f.adapter.closeTicket).not.toHaveBeenCalled();
    }
  );
  it.each([[[]], [['1', '2']]])('company resolution fails closed for %j', async (companies) => {
    const f = harness();
    f.ctx.companyIds = companies;
    await f.run();
    expect(f.ctx.mapping.createState).toBe(
      companies.length ? 'skipped_ambiguous_company' : 'skipped_no_company'
    );
    expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
  });
  it('state machine refuses early wake and live leases', () => {
    const f = harness();
    f.ctx.mapping.nextAttemptAt = new Date(start.getTime() + 1000);
    expect(nextOperation(f.ctx.mapping, f.ctx.alert, start)).toBe('none');
    f.ctx.mapping.nextAttemptAt = null;
    f.ctx.mapping.leaseUntil = new Date(start.getTime() + 1000);
    expect(nextOperation(f.ctx.mapping, f.ctx.alert, start)).toBe('none');
  });
});

import { psaTicketingJobDataSchema } from '../../jobs/queueSchemas';
describe('PSA queue boundary', () => {
  it('only accepts a mapping UUID and an operation hint', () => {
    const data = { mappingId: '11111111-1111-4111-8111-111111111111', op: 'create' };
    expect(psaTicketingJobDataSchema.safeParse(data).success).toBe(true);
    expect(psaTicketingJobDataSchema.safeParse({ ...data, credentials: 'secret' }).success).toBe(
      false
    );
    expect(psaTicketingJobDataSchema.safeParse({ ...data, mappingId: 'bad' }).success).toBe(false);
    expect(psaTicketingJobDataSchema.safeParse({ ...data, op: 'delete' }).success).toBe(false);
  });
});

it('resolve notes fail at 24 hours rather than using the close deadline', async () => {
  const f = harness();
  f.ctx.snapshot.closeOnResolve = false;
  await f.run();
  f.ctx.alert!.status = 'resolved';
  f.ctx.alert!.resolvedAt = start;
  f.advance(25 * 3600000);
  await f.run();
  expect(f.ctx.mapping.closeState).toBe('failed');
  expect(f.adapter.addNote).not.toHaveBeenCalled();
});
it('uncertain acknowledgement notes fail at the deadline without another POST', async () => {
  const f = harness();
  await f.run();
  f.ctx.alert!.acknowledgedAt = start;
  f.adapter.addNote.mockRejectedValueOnce(adapterError('unknown_outcome'));
  await f.run();
  f.advance(25 * 3600000);
  await f.run();
  expect(f.ctx.mapping.noteState).toBe('failed');
  expect(f.adapter.addNote).toHaveBeenCalledTimes(1);
});

it('a marker lookup error after two hours also ends in needs_attention', async () => {
  const f = harness();
  f.adapter.createAlertTicket.mockRejectedValueOnce(adapterError('unknown_outcome'));
  await f.run();
  f.advance(7200001);
  f.adapter.findTicketsByMarker.mockRejectedValueOnce(adapterError('transient'));
  await f.run();
  expect(f.ctx.mapping.createState).toBe('needs_attention');
  expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
});


it('actual closes remain eligible after 25 hours', async () => {
  const f = harness();
  f.ctx.snapshot.closeOnResolve = true;
  await f.run();
  f.ctx.alert!.status = 'resolved';
  f.ctx.alert!.resolvedAt = start;
  f.advance(25 * 3600000);
  await f.run();
  expect(f.adapter.closeTicket).toHaveBeenCalledTimes(1);
  expect(f.ctx.mapping.closeState).not.toBe('failed');
});
it('three pre-send transient creates grow backoff and refund the create cap', async () => {
  const f = harness();
  let cap = 0;
  f.deps.beforeCreate = vi.fn(async () => { cap++; return true; });
  f.deps.refundCreateBudget = vi.fn(async () => { cap--; });
  f.adapter.createAlertTicket.mockRejectedValue(adapterError('transient'));
  for (const delay of [30000, 60000, 120000]) {
    const attemptAt = f.now().getTime();
    await f.run();
    expect(f.ctx.mapping.nextAttemptAt!.getTime() - attemptAt).toBe(delay);
    expect(cap).toBe(0);
    f.advance(delay);
  }
  expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(3);
});
it('auth pause failure still finalizes the row and reports the real failure', async () => {
  const f = harness();
  const error = new Error('pause write failed', { cause: new Error('database unavailable') });
  vi.mocked(f.deps.pause).mockRejectedValueOnce(error);
  f.adapter.createAlertTicket.mockRejectedValueOnce(adapterError('auth'));
  await expect(f.run()).rejects.toBe(error);
  expect(f.ctx.mapping.createState).toBe('never_attempted');
  expect(f.ctx.mapping.lastErrorClass).toBe('auth');
  expect(f.ctx.mapping.leaseToken).toBeNull();
  expect(f.deps.report).toHaveBeenCalledWith(expect.anything(), 'PSA_ALERT_TICKET_AUTH_PAUSED', error);
});
it('logs each adapter failure with ids and forwards real unknown errors with cause', async () => {
  const f = harness();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const error = new Error('unexpected adapter failure', { cause: new Error('root cause') });
  f.adapter.createAlertTicket.mockRejectedValueOnce(error);
  await f.run();
  expect(log).toHaveBeenCalledWith('[psa-ticketing] operation failed', expect.objectContaining({
    mappingId: 'mapping', alertId: 'alert', connectionId: 'connection', op: 'create',
    attempt: 1, errorClass: 'unknown_outcome', message: error.message,
  }));
  expect(f.deps.report).toHaveBeenCalledWith(expect.anything(), 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN', error);
  log.mockRestore();
});
it('logs a rejected save after a remote effect', async () => {
  const f = harness();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(f.deps.save).mockResolvedValueOnce(false);
  await f.run();
  expect(log).toHaveBeenCalledWith('[psa-ticketing] write-back rejected', expect.objectContaining({
    mappingId: 'mapping', op: 'create', token: expect.any(String),
  }));
  log.mockRestore();
});
it('inactive creates persist a reason and delayed wake without posting', async () => {
  const f = harness();
  f.ctx.canCreate = false;
  await f.run();
  expect(f.ctx.mapping.lastError).toMatch(/^connection_inactive:/);
  expect(f.ctx.mapping.nextAttemptAt!.getTime()).toBeGreaterThan(start.getTime());
  expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
});
it('a failed acknowledgement note uses the close/note error id', async () => {
  const f = harness();
  await f.run();
  f.ctx.alert!.acknowledgedAt = start;
  f.adapter.addNote.mockRejectedValueOnce(adapterError('rejected'));
  await f.run();
  expect(f.deps.report).toHaveBeenCalledWith(expect.anything(), 'PSA_ALERT_TICKET_CLOSE_FAILED', undefined);
});
it('renews the Postgres lease before a remote call and refuses lost ownership', async () => {
  const f = harness();
  f.deps.renewLease = vi.fn(async () => false);
  await f.run();
  expect(f.deps.renewLease).toHaveBeenCalledWith('mapping', expect.any(String), expect.any(Date));
  expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
  expect(f.ctx.mapping.lastError).toBe('redis_lease_lost');
});

it.each(['close', 'adopt_lookup'] as const)('reports real unexpected errors from retryable %s calls', async op => {
  const f = harness();
  const error = new Error('unexpected implementation error', { cause: new Error('root cause') });
  if (op === 'close') {
    await f.run();
    f.ctx.alert!.status = 'resolved';
    f.ctx.alert!.resolvedAt = start;
    f.adapter.closeTicket.mockRejectedValueOnce(error);
  } else {
    f.ctx.mapping.createState = 'create_outcome_unknown';
    f.ctx.mapping.createSnapshot = { ...f.ctx.snapshot, unknownDeadline: new Date(start.getTime() + 7200000).toISOString() };
    f.adapter.findTicketsByMarker.mockRejectedValueOnce(error);
  }
  await f.run();
  expect(f.deps.report).toHaveBeenCalledWith(expect.anything(), 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN', error);
});

it.each(['auth', 'transient', 'rate_limited', 'rejected', 'unknown_outcome'] as const)(
  'logs safe diagnostics for %s even without Sentry', async errorClass => {
    const f = harness();
    const error = adapterError(errorClass);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.adapter.createAlertTicket.mockRejectedValueOnce(error);
    try {
      await f.run();
      expect(log).toHaveBeenCalledWith('[psa-ticketing] operation failed', {
        mappingId: 'mapping', alertId: 'alert', connectionId: 'connection', op: 'create',
        attempt: 1, errorClass, httpStatus: error.httpStatus, message: error.message,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET BODY');
    } finally { log.mockRestore(); }
  }
);
it('renews both fences throughout a long remote call and stops renewal on completion', async () => {
  const f = harness();
  let finish!: (value: typeof ref) => void;
  f.adapter.createAlertTicket.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.deps.renewLease = vi.fn(async () => true);
  f.deps.beforeCall = vi.fn(async () => {});
  vi.useFakeTimers();
  const pending = f.run();
  try {
    await vi.waitFor(() => expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(40001);
    expect(f.deps.renewLease).toHaveBeenCalledTimes(3);
    expect(f.deps.beforeCall).toHaveBeenCalledTimes(3);
  } finally {
    finish(ref);
    await pending;
    await vi.advanceTimersByTimeAsync(20001);
    expect(f.deps.renewLease).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  }
});
