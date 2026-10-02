import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  noteProviderFailure: vi.fn(async (..._a: unknown[]) => undefined),
  checkBudgetDetailed: vi.fn(async (..._a: unknown[]): Promise<{ message: string } | null> => null),
  reserveAiBudget: vi.fn(async (i: { idempotencyKey: string }) => ({
    kind: 'reserved', reservationId: `res:${i.idempotencyKey}`, reservedCostCents: 50,
    dailyPeriodKey: 'd', monthlyPeriodKey: 'm', status: 'active',
  })),
  settleInvocation: vi.fn(async (..._a: unknown[]) => ({ costCents: 0, invocationIds: ['inv'], deferred: false })),
}));
vi.mock('./offeringHealth', () => ({ noteProviderFailure: h.noteProviderFailure }));
vi.mock('../aiCostTracker', () => ({ checkBudgetDetailed: h.checkBudgetDetailed }));
vi.mock('../aiBudgetReservations', () => ({ reserveAiBudget: h.reserveAiBudget }));
vi.mock('./settleInvocation', () => ({ settleInvocation: h.settleInvocation }));

import { makeResolvedModel } from './__fixtures__/resolvedModel';
import { MessageDispatchError } from './connectionFactory';
import {
  completedAttemptsOf,
  FailoverExhaustedError,
  isPreOutputMessagesFailure,
  reserveFailoverHop,
  runWithFailover,
  settleZeroUsageHop,
  type FailoverHop,
} from './failoverDispatch';
import { turnBindingFrom } from './turnBinding';

const overloaded = () => Object.assign(new Error('Overloaded'), {
  status: 529, error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
});
const primary = makeResolvedModel('platform', { offering: { id: 'p', displayName: 'P' }, failoverRemaining: ['k'] });
const backup = makeResolvedModel('anthropic_byok', {
  offering: { id: 'k', displayName: 'K' }, failover: { fromOfferingId: 'p', hop: 1, cause: 'overloaded' }, failoverRemaining: [],
});
const first = (): FailoverHop => ({
  index: 0, resolved: primary, binding: turnBindingFrom(primary), reservationId: 'res0', idempotencyKey: 'base', reservedCostCents: 50,
});
const ctx = { orgId: 'org-1', userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09' };

beforeEach(() => vi.clearAllMocks());

describe('runWithFailover', () => {
  it('on a pre-output 529: cools the primary, settles it on ITS reservation, re-resolves excluding it, reserves the next hop under base:hop:1', async () => {
    const reResolve = vi.fn(async () => backup);
    const attempt = vi.fn()
      .mockRejectedValueOnce(overloaded())
      .mockResolvedValueOnce('served');
    const out = await runWithFailover({
      first: first(), reResolve, reserveHop: reserveFailoverHop({ orgId: 'org-1' }), attempt,
      settleFailedHop: settleZeroUsageHop(ctx),
    });
    expect(h.noteProviderFailure).toHaveBeenCalledWith(primary, 'overloaded');
    expect(h.settleInvocation).toHaveBeenCalledTimes(1);
    expect(h.settleInvocation.mock.calls[0]![0]).toMatchObject({ reservationId: 'res0', usage: [], binding: { offeringId: 'p', funding: 'platform' } });
    expect(reResolve).toHaveBeenCalledWith({
      excludeOfferingIds: ['p'], cause: 'overloaded', origin: { offeringId: 'p', funding: 'platform', connectionId: null },
    });
    expect(h.checkBudgetDetailed).toHaveBeenCalledWith('org-1', 'partner_key');           // the NEXT hop's funding
    expect(h.reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'base:hop:1', billingSource: 'partner_key', binding: expect.objectContaining({ offeringId: 'k' }),
    }));
    expect(out).toMatchObject({ value: 'served', hop: { index: 1, reservationId: 'res:base:hop:1', reservedCostCents: 50, binding: { offeringId: 'k' } } });
    expect(attempt.mock.calls[1]![0]).toMatchObject({ index: 1, binding: { offeringId: 'k', funding: 'partner_key' } });
  });

  it('a refusal answered, then its catalog refusal-fallback failing with 529, carries the burned attempt and never fails over (Codex 3)', async () => {
    const burned = [{ wireModel: 'w', message: { stop_reason: 'refusal' } }];
    const err = new MessageDispatchError(burned as never, overloaded());
    const reResolve = vi.fn();
    await expect(runWithFailover({ first: first(), reResolve, reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(err),
      settleFailedHop: vi.fn(), isPreOutput: isPreOutputMessagesFailure })).rejects.toBe(err);
    expect(reResolve).not.toHaveBeenCalled();
    expect(completedAttemptsOf(err)).toEqual(burned);
  });

  it('an unclassified error is rethrown with the hop UNSETTLED (the surface\'s W03 handling runs)', async () => {
    const err = new Error('parse failure');
    await expect(runWithFailover({ first: first(), reResolve: vi.fn(), reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(err), settleFailedHop: vi.fn() }))
      .rejects.toBe(err);
    expect(h.settleInvocation).not.toHaveBeenCalled();
    expect(h.noteProviderFailure).not.toHaveBeenCalled();
  });

  it('a timeout (no provider status) is never a failover: the outcome is unknown (D8)', async () => {
    const err = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
    const reResolve = vi.fn();
    await expect(runWithFailover({ first: first(), reResolve, reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(err), settleFailedHop: vi.fn() }))
      .rejects.toBe(err);
    expect(reResolve).not.toHaveBeenCalled();
  });

  it('no configured fallback: the original error, unsettled, after marking the cooldown', async () => {
    const lone: FailoverHop = { ...first(), resolved: { ...primary, failoverRemaining: [] } };
    const err = overloaded();
    const settleFailedHop = vi.fn();
    await expect(runWithFailover({ first: lone, reResolve: vi.fn(), reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(err), settleFailedHop }))
      .rejects.toBe(err);
    expect(settleFailedHop).not.toHaveBeenCalled();
    expect(h.noteProviderFailure).toHaveBeenCalled();
  });

  it('after output (isPreOutput false): never fails over', async () => {
    const err = Object.assign(overloaded(), { attempts: [{ wireModel: 'x', message: {} }] });
    const reResolve = vi.fn();
    await expect(runWithFailover({ first: first(), reResolve, reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(err),
      settleFailedHop: vi.fn(), isPreOutput: isPreOutputMessagesFailure })).rejects.toBe(err);
    expect(reResolve).not.toHaveBeenCalled();
  });

  it('nothing to fail over to: FailoverExhaustedError, with the failed hop already settled', async () => {
    const settleFailedHop = vi.fn(async () => undefined);
    const e = await runWithFailover({
      first: first(), reResolve: vi.fn(async () => ({ ok: false as const, reason: 'model_unavailable' as const, recoverable: true as const, offeringId: null, message: 'x' })),
      reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(overloaded()), settleFailedHop,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(FailoverExhaustedError);
    expect([e.stop, e.lastHop.index]).toEqual(['no_next_hop', 0]);
    expect(settleFailedHop).toHaveBeenCalledTimes(1);
  });

  it('the next hop\'s admission is denied (credits): stops, reserves nothing', async () => {
    h.checkBudgetDetailed.mockResolvedValueOnce({ message: 'Out of AI credits' });
    const e = await runWithFailover({
      first: first(), reResolve: vi.fn(async () => backup), reserveHop: reserveFailoverHop({ orgId: 'org-1' }),
      attempt: vi.fn().mockRejectedValue(overloaded()), settleFailedHop: vi.fn(async () => undefined),
    }).catch((x) => x);
    expect([e.stop, e.admissionMessage]).toEqual(['admission_denied', 'Out of AI credits']);
    expect(h.reserveAiBudget).not.toHaveBeenCalled();
  });

  it('a re-resolution that returns an already-tried offering is not retried', async () => {
    const e = await runWithFailover({
      first: first(), reResolve: vi.fn(async () => primary), reserveHop: vi.fn(),
      attempt: vi.fn().mockRejectedValue(overloaded()), settleFailedHop: vi.fn(async () => undefined),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(FailoverExhaustedError);
  });

  it('two failing hops: each settled on its own reservation, the third serves under base:hop:2', async () => {
    const backup2 = makeResolvedModel('platform', {
      offering: { id: 'p2', displayName: 'P2' }, failover: { fromOfferingId: 'p', hop: 2, cause: 'overloaded' }, failoverRemaining: [],
    });
    const settleFailedHop = vi.fn(async (_hop: FailoverHop) => undefined);
    const reResolve = vi.fn().mockResolvedValueOnce({ ...backup, failoverRemaining: ['p2'] }).mockResolvedValueOnce(backup2);
    const out = await runWithFailover({
      first: first(), reResolve, reserveHop: reserveFailoverHop({ orgId: 'org-1' }),
      attempt: vi.fn().mockRejectedValueOnce(overloaded()).mockRejectedValueOnce(overloaded()).mockResolvedValueOnce('ok'),
      settleFailedHop,
    });
    expect(settleFailedHop.mock.calls.map((c) => c[0].reservationId)).toEqual(['res0', 'res:base:hop:1']);
    expect(reResolve.mock.calls[1]![0]).toMatchObject({ excludeOfferingIds: ['p', 'k'], origin: { offeringId: 'p', funding: 'platform' } });
    expect(out.hop).toMatchObject({ index: 2, idempotencyKey: 'base:hop:2', binding: { offeringId: 'p2' } });
  });
});

describe('settleZeroUsageHop', () => {
  it('settles zero usage with stop reason error, messageCount 0, on the hop\'s own reservation and binding', async () => {
    await settleZeroUsageHop(ctx)(first());
    expect(h.settleInvocation).toHaveBeenCalledWith(expect.objectContaining({
      reservationId: 'res0', usage: [], messageCount: 0, toolExecutionCount: 0, turnCount: 0,
      binding: expect.objectContaining({ offeringId: 'p' }),
      outcome: expect.objectContaining({ stopReason: 'error', refused: false }),
    }));
  });
});

describe('completedAttemptsOf', () => {
  it('reads a surface error\'s own attempts and nothing from a plain error', () => {
    expect(completedAttemptsOf(Object.assign(new Error('x'), { attempts: [{ wireModel: 'a' }] }))).toHaveLength(1);
    expect(completedAttemptsOf(new Error('x'))).toEqual([]);
    expect(completedAttemptsOf(null)).toEqual([]);
  });
});
