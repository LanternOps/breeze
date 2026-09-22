/**
 * #4248 W03 (Task 8) — the reconciliation pass for unsettled narrative
 * deliveries. Everything below the sweep (`listUnsettledDeliveries`,
 * `settleDelivery`, `deliverNarrativeEmails`) is mocked; what this file owns
 * is WHICH rows the sweep touches and how.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string; reportRunId: string; recipientUserId: string; channel: 'email';
  state: 'pending' | 'claimed' | 'sent' | 'failed' | 'unknown';
  attempts: number; lastError: string | null; claimedAt: Date | null; createdAt: Date;
};

const fake = vi.hoisted(() => ({
  rows: [] as Row[],
  runOrgs: new Map<string, string>(),
  // #3198 W01 — runs whose report is PARTNER-owned (org_id NULL).
  runPartners: new Map<string, string>(),
}));

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); getRepeatableJobs = vi.fn(async () => []); removeRepeatableByKey = vi.fn(); close = vi.fn(); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

vi.mock('../db', () => {
  const makeSelect = () => ({
    from: vi.fn(() => {
      const b: Record<string, unknown> = {
        innerJoin: vi.fn(() => b),
        where: vi.fn(() => b),
        limit: vi.fn(() => b),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => [
            ...[...fake.runOrgs.entries()].map(([reportRunId, orgId]) => ({ reportRunId, orgId, partnerId: null })),
            ...[...fake.runPartners.entries()].map(([reportRunId, partnerId]) => ({ reportRunId, orgId: null, partnerId })),
          ])
            .then(resolve, reject),
      };
      return b;
    }),
  });
  return {
    db: { select: vi.fn(() => makeSelect()) },
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

const settleDelivery = vi.hoisted(() => vi.fn(async (id: string, outcome: { state: Row['state']; error?: string }) => {
  const row = fake.rows.find((r) => r.id === id);
  if (row && row.state === 'claimed') { row.state = outcome.state; row.lastError = outcome.error ?? null; }
}));
vi.mock('../services/reportRunDelivery', () => ({
  STALE_CLAIM_MS: 15 * 60 * 1000,
  listUnsettledDeliveries: vi.fn(async (olderThan: Date, limit: number) =>
    fake.rows
      .filter((r) => (r.state === 'pending' || r.state === 'claimed') && (r.claimedAt ?? r.createdAt) < olderThan)
      .slice(0, limit)),
  settleDelivery,
}));

const deliverNarrativeEmails = vi.hoisted(() => vi.fn(async (reportRunId: string, _ctx: { orgId: string }) => {
  let sentNow = 0;
  for (const row of fake.rows) {
    if (row.reportRunId === reportRunId && row.state === 'pending') { row.state = 'sent'; sentNow += 1; }
  }
  return { total: 1, sent: sentNow, failed: 0, unknown: 0, pending: 0, refused: 0, transient: 0, sentNow };
}));
vi.mock('../services/reportNarrativeDelivery', () => ({ deliverNarrativeEmails }));

import { reconcileReportRunDeliveries, RECONCILE_INTERVAL_MS } from './reportRunDeliveryReconciler';
import { STALE_CLAIM_MS } from '../services/reportRunDelivery';

const RUN_A = '00000000-0000-4000-8000-0000000000b1';
const RUN_B = '00000000-0000-4000-8000-0000000000b2';
const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000a2';

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}
let seq = 0;
function seedDelivery(input: Partial<Row> & { state: Row['state'] }): Row {
  const row: Row = {
    id: `d${++seq}`, reportRunId: RUN_A, recipientUserId: `u${seq}`, channel: 'email',
    attempts: 0, lastError: null, claimedAt: null, createdAt: hoursAgo(2), ...input,
  };
  fake.rows.push(row);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.rows = [];
  fake.runOrgs = new Map([[RUN_A, ORG_A], [RUN_B, ORG_B]]);
  fake.runPartners = new Map();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('reconcileReportRunDeliveries (#4248 W03)', () => {
  it('runs on a 15-minute cadence', () => {
    expect(RECONCILE_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  // The sweep can only mark a claim stale if it SEES it: the list query uses
  // the cadence cutoff, so a STALE_CLAIM_MS shorter than one tick would burn
  // claims the pass never looked at, and a longer one is handled by the
  // re-check in the job. Pinned because nothing else couples the two.
  it('never lets the stale-claim window fall below one cadence tick', () => {
    expect(STALE_CLAIM_MS).toBeGreaterThanOrEqual(RECONCILE_INTERVAL_MS);
  });

  it('reports a sustained backlog to Sentry, not only to the log', async () => {
    for (let i = 0; i < 500; i += 1) seedDelivery({ state: 'pending', reportRunId: RUN_A });
    const { captureException } = await import('../services/sentry');

    await reconcileReportRunDeliveries();

    expect(vi.mocked(captureException)).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/row cap|backlog/i) }),
    );
  });

  it('logs — never silently drops — pending rows whose run vanished between the two reads', async () => {
    seedDelivery({ state: 'pending', reportRunId: RUN_A });
    fake.runOrgs = new Map(); // the join finds nothing

    const out = await reconcileReportRunDeliveries();

    expect(out).toMatchObject({ resent: 0, markedUnknown: 0 });
    expect(deliverNarrativeEmails).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toMatch(/vanished/i);
  });

  it('sends a pending row the finalizer never got to, through the full gated path', async () => {
    seedDelivery({ state: 'pending', createdAt: hoursAgo(2) });

    const out = await reconcileReportRunDeliveries();

    expect(out).toMatchObject({ resent: 1, markedUnknown: 0 });
    expect(deliverNarrativeEmails).toHaveBeenCalledTimes(1);
    expect(deliverNarrativeEmails).toHaveBeenCalledWith(RUN_A, { orgId: ORG_A });
  });

  it('calls the delivery pass ONCE per run, not once per row', async () => {
    seedDelivery({ state: 'pending' });
    seedDelivery({ state: 'pending' });
    seedDelivery({ state: 'pending', reportRunId: RUN_B });

    const out = await reconcileReportRunDeliveries();

    expect(deliverNarrativeEmails).toHaveBeenCalledTimes(2);
    expect(out.resent).toBe(3);
  });

  it('leaves a pending row younger than one cadence tick alone (the finalizer may still be running)', async () => {
    seedDelivery({ state: 'pending', createdAt: new Date(Date.now() - 60 * 1000) });

    const out = await reconcileReportRunDeliveries();

    expect(deliverNarrativeEmails).not.toHaveBeenCalled();
    expect(out).toMatchObject({ resent: 0, markedUnknown: 0 });
  });

  it('marks a stale claim unknown and does NOT resend it', async () => {
    const row = seedDelivery({ state: 'claimed', claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 1) });

    const out = await reconcileReportRunDeliveries();

    expect(out).toMatchObject({ resent: 0, markedUnknown: 1 });
    expect(deliverNarrativeEmails).not.toHaveBeenCalled();
    expect(row.state).toBe('unknown');
    expect(row.lastError).toMatch(/stale/i);
    expect(settleDelivery).toHaveBeenCalledWith(row.id, { state: 'unknown', error: expect.stringMatching(/stale/i) });
  });

  it('leaves a fresh claim alone', async () => {
    seedDelivery({ state: 'claimed', claimedAt: new Date() });

    const out = await reconcileReportRunDeliveries();

    expect(out).toMatchObject({ resent: 0, markedUnknown: 0 });
    expect(settleDelivery).not.toHaveBeenCalled();
  });

  it('never touches sent, failed or unknown rows', async () => {
    for (const state of ['sent', 'failed', 'unknown'] as const) {
      seedDelivery({ state, claimedAt: hoursAgo(9) });
    }

    const out = await reconcileReportRunDeliveries();

    expect(out).toMatchObject({ resent: 0, markedUnknown: 0 });
    expect(deliverNarrativeEmails).not.toHaveBeenCalled();
    expect(settleDelivery).not.toHaveBeenCalled();
    expect(fake.rows.map((r) => r.state)).toEqual(['sent', 'failed', 'unknown']);
  });

  it('keeps sweeping the other runs when one run\'s pass throws', async () => {
    seedDelivery({ state: 'pending', reportRunId: RUN_A });
    seedDelivery({ state: 'pending', reportRunId: RUN_B });
    deliverNarrativeEmails.mockRejectedValueOnce(new Error('pg down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const out = await reconcileReportRunDeliveries();

    expect(deliverNarrativeEmails).toHaveBeenCalledTimes(2);
    expect(out.resent).toBe(1);
    expect(error).toHaveBeenCalled();
  });

  it('never hands a PARTNER-owned run to the org-keyed narrative delivery; reports it and keeps sweeping (#3198 W01)', async () => {
    const RUN_P = '00000000-0000-4000-8000-0000000000b3';
    const PARTNER = '00000000-0000-4000-8000-0000000000c1';
    fake.runPartners = new Map([[RUN_P, PARTNER]]);
    seedDelivery({ state: 'pending', reportRunId: RUN_P });
    seedDelivery({ state: 'pending', reportRunId: RUN_A });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { captureException } = await import('../services/sentry');

    const out = await reconcileReportRunDeliveries();

    expect(deliverNarrativeEmails).toHaveBeenCalledTimes(1);
    expect(deliverNarrativeEmails).toHaveBeenCalledWith(RUN_A, { orgId: ORG_A });
    expect(out.resent).toBe(1);
    // Not the benign "vanished" path: an unsupported owner is surfaced.
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).not.toMatch(/vanished/i);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/partner-owned/i),
      expect.objectContaining({ reportRunId: RUN_P, partnerId: PARTNER }),
    );
    expect(vi.mocked(captureException)).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/partner-owned/i) }),
    );
  });
});
