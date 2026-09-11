import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sweep JOB, not the SQL.
 *
 * `expireStaleAiBudgetReservations` (the single UPDATE) is proven against real
 * Postgres in `__tests__/integration/ai-budget-reservations.integration.test.ts`
 * — including the settle-vs-sweep race, which a mock cannot express. What is
 * left to pin here is the wrapper: that the worker's processor runs the sweep
 * inside a SYSTEM db context (without one the forced-RLS UPDATE silently
 * matches zero rows and the job reports a cheerful 0 forever), that it reports
 * through a registered Sentry event code and tag rather than a scrubbed-away
 * breadcrumb, and that hitting the per-run cap is surfaced instead of quietly
 * leaving a backlog.
 */

const { hoisted } = vi.hoisted(() => ({
  hoisted: {
    processors: [] as Array<(job: unknown) => Promise<unknown>>,
    queueAdd: vi.fn(async () => undefined),
    queueGetRepeatables: vi.fn(async () => []),
    withSystemDbAccessContext: vi.fn(),
    expireStaleAiBudgetReservations: vi.fn(),
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    getBullMQConnection: vi.fn(() => ({})),
    attachWorkerObservability: vi.fn(),
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = hoisted.queueAdd;
    getRepeatableJobs = hoisted.queueGetRepeatables;
    removeRepeatableByKey = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
  },
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>) {
      hoisted.processors.push(processor);
    }
    on = vi.fn();
    close = vi.fn(async () => undefined);
  },
}));
vi.mock('../db', () => ({ withSystemDbAccessContext: hoisted.withSystemDbAccessContext }));
vi.mock('../services/redis', () => ({ getBullMQConnection: hoisted.getBullMQConnection }));
vi.mock('../services/sentry', () => ({
  captureMessage: hoisted.captureMessage,
  captureException: hoisted.captureException,
}));
vi.mock('./workerObservability', () => ({
  attachWorkerObservability: hoisted.attachWorkerObservability,
}));
vi.mock('../services/aiBudgetReservations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/aiBudgetReservations')>()),
  expireStaleAiBudgetReservations: hoisted.expireStaleAiBudgetReservations,
}));

import {
  initializeAiBudgetReservationSweep,
  shutdownAiBudgetReservationSweep,
  sweepExpiredAiBudgetReservations,
} from './aiBudgetReservationSweep';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function expiredRow(overrides: Partial<{
  reservationId: string;
  orgId: string;
  reason: 'active_ttl' | 'indeterminate_ttl';
  reservedCostCents: number;
}> = {}) {
  return {
    reservationId: '12121212-1212-4121-8121-121212121212',
    orgId: ORG_A,
    reason: 'active_ttl' as const,
    reservedCostCents: 25,
    ...overrides,
  };
}

describe('sweepExpiredAiBudgetReservations', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    hoisted.expireStaleAiBudgetReservations.mockResolvedValue([]);
  });

  it('reports nothing and captures nothing when there is no backlog', async () => {
    await expect(sweepExpiredAiBudgetReservations()).resolves.toBe(0);
    expect(hoisted.captureMessage).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('counts what it reclaimed and logs one structured line per row', async () => {
    hoisted.expireStaleAiBudgetReservations.mockResolvedValue([
      expiredRow({ reservationId: 'r1', reason: 'active_ttl', reservedCostCents: 25 }),
      expiredRow({ reservationId: 'r2', reason: 'indeterminate_ttl', reservedCostCents: 40 }),
    ]);

    await expect(sweepExpiredAiBudgetReservations()).resolves.toBe(2);

    expect(warn).toHaveBeenCalledWith('[AiBudgetReservationSweep] reservation expired', {
      reservationId: 'r1', orgId: ORG_A, reason: 'active_ttl', reservedCostCents: 25,
    });
    expect(warn).toHaveBeenCalledWith(
      '[AiBudgetReservationSweep] reclaimed 2 reservation(s) (active_ttl=1, indeterminate_ttl=1)',
    );
  });

  it('captures ONE grouped Sentry message with a registered code and a bounded tag', async () => {
    hoisted.expireStaleAiBudgetReservations.mockResolvedValue([
      expiredRow({ reservationId: 'r1' }),
      expiredRow({ reservationId: 'r2' }),
      expiredRow({ reservationId: 'r3' }),
    ]);

    await sweepExpiredAiBudgetReservations();

    // One issue saying "budgets are being reclaimed", not one per reservation.
    expect(hoisted.captureMessage).toHaveBeenCalledTimes(1);
    expect(hoisted.captureMessage).toHaveBeenCalledWith(
      'AI budget reservations expired without settling',
      { eventCode: 'ai_budget_reservation_expired', tags: { ai_budget_expiry_reason: 'active_ttl' } },
    );
  });

  it('tags the indeterminate TTL when that is the only reason that fired', async () => {
    hoisted.expireStaleAiBudgetReservations.mockResolvedValue([
      expiredRow({ reason: 'indeterminate_ttl' }),
    ]);

    await sweepExpiredAiBudgetReservations();

    expect(hoisted.captureMessage).toHaveBeenCalledWith(
      'AI budget reservations expired without settling',
      expect.objectContaining({ tags: { ai_budget_expiry_reason: 'indeterminate_ttl' } }),
    );
  });

  it('warns when the per-run cap is hit, because the backlog then outlives the run', async () => {
    const MAX_PER_RUN = 500;
    hoisted.expireStaleAiBudgetReservations.mockResolvedValue(
      Array.from({ length: MAX_PER_RUN }, (_unused, index) =>
        expiredRow({ reservationId: `r${index}` })),
    );

    await expect(sweepExpiredAiBudgetReservations()).resolves.toBe(MAX_PER_RUN);

    expect(hoisted.expireStaleAiBudgetReservations).toHaveBeenCalledWith(MAX_PER_RUN);
    expect(warn).toHaveBeenCalledWith(
      `[AiBudgetReservationSweep] hit the ${MAX_PER_RUN}-row cap — backlog may be growing`,
    );
  });

  it('does not warn about a backlog when the run came in under the cap', async () => {
    hoisted.expireStaleAiBudgetReservations.mockResolvedValue([expiredRow()]);

    await sweepExpiredAiBudgetReservations();

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('cap — backlog may be growing'));
  });
});

describe('the sweep worker', () => {
  beforeEach(async () => {
    await shutdownAiBudgetReservationSweep();
    vi.clearAllMocks();
    hoisted.processors.length = 0;
    hoisted.expireStaleAiBudgetReservations.mockResolvedValue([]);
    hoisted.withSystemDbAccessContext.mockImplementation((fn: () => unknown) => fn());
  });

  it('runs each pass inside a labelled SYSTEM db context', async () => {
    await initializeAiBudgetReservationSweep();
    const processor = hoisted.processors[0];
    expect(processor).toBeDefined();

    hoisted.expireStaleAiBudgetReservations.mockResolvedValue([expiredRow()]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(processor!({})).resolves.toEqual({ expired: 1 });

    // Forced RLS: contextless, the UPDATE matches zero rows and the job would
    // report success forever while every cap stayed held.
    expect(hoisted.withSystemDbAccessContext).toHaveBeenCalledWith(
      expect.any(Function),
      'aiBudgetReservationSweep.expire',
    );
    expect(hoisted.attachWorkerObservability).toHaveBeenCalledWith(
      expect.anything(),
      'aiBudgetReservationSweep',
    );
  });

  it('schedules itself as a 5-minute repeatable job', async () => {
    await initializeAiBudgetReservationSweep();

    expect(hoisted.queueAdd).toHaveBeenCalledWith(
      'expire-stale-ai-budget-reservations',
      expect.objectContaining({ type: 'expire-stale-ai-budget-reservations' }),
      expect.objectContaining({
        jobId: 'ai-budget-reservation-sweep',
        repeat: { every: 5 * 60 * 1000 },
      }),
    );
  });

  it('captures and rethrows a failed pass rather than reporting a silent zero', async () => {
    await initializeAiBudgetReservationSweep();
    const processor = hoisted.processors[0]!;
    const boom = new Error('pool exhausted');
    hoisted.expireStaleAiBudgetReservations.mockRejectedValue(boom);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(processor({})).rejects.toThrow('pool exhausted');
    expect(hoisted.captureException).toHaveBeenCalledWith(boom);
  });
});
