import { describe, expect, it } from 'vitest';
import { cancelledRefusal, intentStateRefusal, reattachRefusal, refusalBody } from './errors';
import {
  normalizeRebindProtocolVersion,
  OPEN_REATTACH_INTENT_STATES,
  REATTACH_REQUESTED_TTL_MS,
  REATTACH_STAGED_TTL_MS,
  REBIND_DIRECTIVE_MAX_LIFETIME_MS,
  TERMINAL_REATTACH_INTENT_STATES,
} from './protocol';

describe('intent state → refusal (#8318 §6.3, §6.4: what an ended intent answers)', () => {
  it('a cancelled intent answers 409 `cancelled` with its reason', () => {
    expect(intentStateRefusal('cancelled', 'restage_refused')).toMatchObject({
      ok: false, status: 409, code: 'cancelled', state: 'cancelled', cancelReason: 'restage_refused',
    });
  });

  it('an expired intent answers 409 `expired`, no reason', () => {
    expect(intentStateRefusal('expired', null)).toMatchObject({ status: 409, code: 'expired', state: 'expired', cancelReason: null });
  });

  it('a confirmed intent (for phase 1) answers 409 `confirmed`', () => {
    expect(intentStateRefusal('confirmed', null)).toMatchObject({ status: 409, code: 'confirmed', state: 'confirmed' });
  });

  it('a confirm on a requested (never staged) intent answers 409 `not_staged`', () => {
    expect(intentStateRefusal('requested', null)).toMatchObject({ status: 409, code: 'not_staged', state: 'requested' });
  });

  it('the call that cancels answers with the reason as its code, state cancelled', () => {
    expect(cancelledRefusal('target_alive')).toMatchObject({
      status: 409, code: 'target_alive', state: 'cancelled', cancelReason: 'target_alive',
    });
  });
});

describe('refusalBody (the agent routes\' JSON)', () => {
  it('carries error + code, and state + cancelReason only when there is a state', () => {
    expect(refusalBody(intentStateRefusal('cancelled', 'admin'))).toEqual({
      error: expect.any(String), code: 'cancelled', state: 'cancelled', cancelReason: 'admin',
    });
    expect(refusalBody(intentStateRefusal('expired', null))).toEqual({
      error: expect.any(String), code: 'expired', state: 'expired', cancelReason: null,
    });
    expect(refusalBody(reattachRefusal(404, 'intent_not_found', 'nope'))).toEqual({ error: 'nope', code: 'intent_not_found' });
    // A cancelReason with no state is never leaked on its own.
    expect(refusalBody(reattachRefusal(409, 'x', 'y', { cancelReason: 'admin' }))).toEqual({ error: 'y', code: 'x' });
  });
});

describe('rebind protocol vocabulary', () => {
  it.each([
    [1, 1],
    [0, 0],
    [2, 0],
    [-1, 0],
    ['1', 0],
    [1.0, 1],
    [undefined, 0],
    [null, 0],
  ])('normalizeRebindProtocolVersion(%j) = %d (exactly 1, else 0)', (input, expected) => {
    expect(normalizeRebindProtocolVersion(input)).toBe(expected);
  });

  it('pins the TTLs decided in review (§13 decision 11) and the directive bound', () => {
    expect(REATTACH_REQUESTED_TTL_MS).toBe(60 * 60 * 1000);
    expect(REATTACH_STAGED_TTL_MS).toBe(15 * 60 * 1000);
    expect(REBIND_DIRECTIVE_MAX_LIFETIME_MS).toBe(15 * 60 * 1000);
  });

  it('open and terminal states partition the state CHECK', () => {
    expect([...OPEN_REATTACH_INTENT_STATES, ...TERMINAL_REATTACH_INTENT_STATES].sort())
      .toEqual(['cancelled', 'confirmed', 'expired', 'requested', 'staged']);
  });
});
