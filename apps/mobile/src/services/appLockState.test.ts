import { describe, expect, it } from 'vitest';

// No mocks: this module deliberately imports nothing, so the security-critical
// logic is reachable from the node-only runtime. See appLockStore.test.ts for
// the keychain half.
import {
  LOCK_GRACE_MS,
  parseAppLockState,
  shouldLockOnLaunch,
  type AppLockState,
} from './appLockState';

const NOW = 1_800_000_000_000;

describe('shouldLockOnLaunch', () => {
  it('locks when there is no record at all', () => {
    // First launch after this shipped, a wiped keychain, or a failed write.
    expect(shouldLockOnLaunch(null, NOW, LOCK_GRACE_MS)).toBe(true);
  });

  it('locks when the app was already locked when the record was written', () => {
    // Force-quitting at the lock screen must not be a way past it, however
    // recent the record is.
    expect(shouldLockOnLaunch({ stampedAt: NOW - 1, locked: true }, NOW, LOCK_GRACE_MS)).toBe(true);
  });

  it('does not lock inside the grace window', () => {
    const record = { stampedAt: NOW - (LOCK_GRACE_MS - 1), locked: false };
    expect(shouldLockOnLaunch(record, NOW, LOCK_GRACE_MS)).toBe(false);
  });

  it('locks exactly at the grace boundary', () => {
    const record = { stampedAt: NOW - LOCK_GRACE_MS, locked: false };
    expect(shouldLockOnLaunch(record, NOW, LOCK_GRACE_MS)).toBe(true);
  });

  it('locks well past the grace window', () => {
    const record = { stampedAt: NOW - LOCK_GRACE_MS * 60, locked: false };
    expect(shouldLockOnLaunch(record, NOW, LOCK_GRACE_MS)).toBe(true);
  });

  it('locks when the clock has moved backwards since the record was written', () => {
    // Both a tampering signal and a case where elapsed time means nothing.
    expect(shouldLockOnLaunch({ stampedAt: NOW + 5_000, locked: false }, NOW, LOCK_GRACE_MS)).toBe(
      true
    );
  });

  it('locks when the elapsed time is not finite', () => {
    expect(shouldLockOnLaunch({ stampedAt: NOW, locked: false }, Number.NaN, LOCK_GRACE_MS)).toBe(
      true
    );
  });

  it('defaults graceMs, so the production call cannot transpose its arguments', () => {
    // `shouldLockOnLaunch(record, Date.now())` takes two parameters of
    // incompatible meaning; passing the grace where `now` belongs would be a
    // silent wrong answer, so the two-argument form is the one call sites use.
    const inside = { stampedAt: NOW - (LOCK_GRACE_MS - 1), locked: false };
    const outside = { stampedAt: NOW - LOCK_GRACE_MS, locked: false };
    expect(shouldLockOnLaunch(inside, NOW)).toBe(false);
    expect(shouldLockOnLaunch(outside, NOW)).toBe(true);
  });
});

describe('parseAppLockState', () => {
  it('accepts a well-formed record', () => {
    expect(parseAppLockState('{"stampedAt":123,"locked":true}')).toEqual({
      stampedAt: 123,
      locked: true,
    });
  });

  it('ignores unknown keys — schema changes bump the storage key instead', () => {
    expect(parseAppLockState('{"stampedAt":123,"locked":false,"v":2}')).toEqual({
      stampedAt: 123,
      locked: false,
    });
  });

  it.each([
    ['a missing key', null],
    ['unparseable JSON', '{'],
    ['a JSON scalar', '42'],
    ['a JSON null', 'null'],
    ['an array', '[]'],
    ['a missing timestamp', '{"locked":false}'],
    ['a null timestamp', '{"stampedAt":null,"locked":false}'],
    ['a non-numeric timestamp', '{"stampedAt":"123","locked":false}'],
    // JSON.stringify(Infinity) is "null", so our own writer cannot produce
    // this — it only arrives from a hand-forged keychain item. Without the
    // Number.isFinite half of the guard this parses, which is why the case is
    // spelled out rather than folded into the null row above.
    ['a non-finite timestamp', '{"stampedAt":1e999,"locked":false}'],
    ['a missing locked flag', '{"stampedAt":123}'],
    ['a non-boolean locked flag', '{"stampedAt":123,"locked":"false"}'],
  ])('rejects %s', (_label, raw) => {
    expect(parseAppLockState(raw)).toBeNull();
  });

  it('feeds a rejected record into a lock, not an unlock', () => {
    // The two halves have to compose this way round: a forged or truncated
    // keychain item must not be a way past the gate.
    expect(shouldLockOnLaunch(parseAppLockState('{"stampedAt":0}'), 0, LOCK_GRACE_MS)).toBe(true);
  });

  it('round-trips a record it produced itself', () => {
    const record: AppLockState = { stampedAt: NOW, locked: false };
    expect(parseAppLockState(JSON.stringify(record))).toEqual(record);
  });
});
