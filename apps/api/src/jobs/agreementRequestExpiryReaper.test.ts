import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit shape of the sweep (#9075 W3b, spec §3.5): which rows it asks for, the
// instant boundary (shared helper), the guarded flip, the audit + bus event per
// transition, and idempotence. The real-Postgres sweep is
// __tests__/integration/agreementRequestExpiryReaper.integration.test.ts.

const queued: unknown[][] = [];
const updated: Array<Record<string, unknown>> = [];
const wheres: unknown[] = [];
function queue(rows: unknown[]) { queued.push(rows); }

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  chain.update = vi.fn(() => chain);
  chain.set = vi.fn((v: Record<string, unknown>) => { updated.push(v); return chain; });
  chain.returning = vi.fn(() => Promise.resolve(queued.shift() ?? []));
  chain.for = vi.fn(() => chain);
  chain.where = vi.fn((w: unknown) => { wheres.push(w); return chain; });
  for (const m of ['select', 'from', 'limit', 'orderBy']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(queued.shift() ?? []).then(resolve, reject);
  return { db: chain, withSystemDbAccessContext: (fn: () => unknown) => fn() };
});

vi.mock('bullmq', () => ({ Queue: vi.fn(), Worker: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

const { auditMock, emitMock } = vi.hoisted(() => ({ auditMock: vi.fn(), emitMock: vi.fn() }));
vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: auditMock,
  requestLikeFromSnapshot: () => ({ req: 'like' }),
}));
vi.mock('../services/agreementEvents', () => ({ emitAgreementEvent: emitMock }));

import { db } from '../db';
import { expireAgreementRequests } from './agreementRequestExpiryReaper';
import { captureException } from '../services/sentry';

const NOW = new Date('2027-01-11T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

beforeEach(() => {
  vi.clearAllMocks();
  queued.length = 0;
  updated.length = 0;
  wheres.length = 0;
});

describe('expireAgreementRequests', () => {
  it('nothing due → 0, no update, no audit, no event', async () => {
    queue([]);
    await expect(expireAgreementRequests(NOW)).resolves.toBe(0);
    expect(db.update).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('flips due rows to expired (status + expired_at + updated_at), audits billing.agreement.expired and emits agreement.expired per row', async () => {
    queue([{ id: 'r1', expiresAt: at(-1000) }, { id: 'r2', expiresAt: at(-60_000) }]); // candidates
    queue([
      { id: 'r1', orgId: 'o1', label: 'BAA', expiresAt: at(-1000), reminderCount: 2 },
      { id: 'r2', orgId: 'o2', label: null, expiresAt: at(-60_000), reminderCount: 0 },
    ]); // flipped
    queue([{ id: 'o1', partnerId: 'p1' }, { id: 'o2', partnerId: 'p2' }]); // org → partner

    await expect(expireAgreementRequests(NOW)).resolves.toBe(2);

    expect(updated).toEqual([{ status: 'expired', expiredAt: NOW, updatedAt: NOW }]);
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(auditMock.mock.calls[0]![1]).toMatchObject({
      orgId: 'o1', action: 'billing.agreement.expired', resourceType: 'agreement_request', resourceId: 'r1',
      actorType: 'system', actorId: null, result: 'success',
      details: { expiresAt: at(-1000).toISOString(), reminderCount: 2 },
    });
    expect(emitMock).toHaveBeenCalledWith({ type: 'agreement.expired', requestId: 'r1', orgId: 'o1', partnerId: 'p1' });
    expect(emitMock).toHaveBeenCalledWith({ type: 'agreement.expired', requestId: 'r2', orgId: 'o2', partnerId: 'p2' });
  });

  it('applies the shared instant boundary: now === expires_at is expired, one ms earlier is not', async () => {
    queue([{ id: 'edge', expiresAt: at(0) }, { id: 'live', expiresAt: at(1) }]);
    queue([{ id: 'edge', orgId: 'o1', label: null, expiresAt: at(0), reminderCount: 0 }]);
    queue([{ id: 'o1', partnerId: 'p1' }]);
    await expect(expireAgreementRequests(NOW)).resolves.toBe(1);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]![0].requestId).toBe('edge');
  });

  it('a candidate the guarded update no longer matches (answered under us) is not reported', async () => {
    queue([{ id: 'r1', expiresAt: at(-1) }]);
    queue([]); // status flipped to signed between the read and the update
    await expect(expireAgreementRequests(NOW)).resolves.toBe(0);
    expect(auditMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('is idempotent: a second pass over the same (now expired) rows finds nothing', async () => {
    queue([{ id: 'r1', expiresAt: at(-1) }]);
    queue([{ id: 'r1', orgId: 'o1', label: null, expiresAt: at(-1), reminderCount: 0 }]);
    queue([{ id: 'o1', partnerId: 'p1' }]);
    await expireAgreementRequests(NOW);
    emitMock.mockClear();
    queue([]);
    await expect(expireAgreementRequests(NOW)).resolves.toBe(0);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('an audit failure for one row never blocks the transition or the other rows', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    auditMock.mockImplementationOnce(() => { throw new Error('audit down'); });
    queue([{ id: 'r1', expiresAt: at(-1) }, { id: 'r2', expiresAt: at(-2) }]);
    queue([
      { id: 'r1', orgId: 'o1', label: null, expiresAt: at(-1), reminderCount: 0 },
      { id: 'r2', orgId: 'o1', label: null, expiresAt: at(-2), reminderCount: 0 },
    ]);
    queue([{ id: 'o1', partnerId: 'p1' }]);
    await expect(expireAgreementRequests(NOW)).resolves.toBe(2);
    expect(auditMock).toHaveBeenCalledTimes(2);
    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(captureException).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
