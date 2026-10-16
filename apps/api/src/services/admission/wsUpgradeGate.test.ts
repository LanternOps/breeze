import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupSlots, TokenBucket } from './wsUpgradeGate';

describe('TokenBucket', () => {
  it('starts full, refills at rate x scale, and caps at burst x scale', () => {
    let nowMs = 0;
    const bucket = new TokenBucket(10, 20, () => nowMs);
    for (let i = 0; i < 20; i += 1) expect(bucket.tryTake(1)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
    nowMs += 100;                                   // 10/s x 0.1 s = 1 token
    expect(bucket.tryTake(1)).toBe(true);
    expect(bucket.tryTake(1)).toBe(false);
    nowMs += 10_000;
    expect(bucket.available(1)).toBe(20);
  });

  it('refund returns a token but never exceeds the scaled capacity', () => {
    const bucket = new TokenBucket(10, 3, () => 0);
    expect(bucket.tryTake(1)).toBe(true);
    expect(bucket.available(1)).toBe(2);
    bucket.refund(1);
    expect(bucket.available(1)).toBe(3);
    bucket.refund(1);
    bucket.refund(1);
    expect(bucket.available(1)).toBe(3);
  });

  it('clamps accumulated tokens when the level drops the scale', () => {
    let nowMs = 0;
    const bucket = new TokenBucket(10, 20, () => nowMs);
    expect(bucket.available(0.05)).toBe(1);         // 20 x 0.05 = 1: no stored burst survives a level change
    expect(bucket.tryTake(0.05)).toBe(true);
    expect(bucket.tryTake(0.05)).toBe(false);
    nowMs += 1_000;                                 // 10 x 0.05 = 0.5 tokens/s
    expect(bucket.tryTake(0.05)).toBe(false);
    nowMs += 1_000;
    expect(bucket.tryTake(0.05)).toBe(true);
  });
});

describe('SetupSlots', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('admits up to max, frees on release, and release is idempotent', () => {
    const slots = new SetupSlots(2);
    const a = slots.tryAcquire();
    const b = slots.tryAcquire();
    expect(slots.tryAcquire()).toBeNull();
    a!.release();
    a!.release();
    expect(slots.inFlight).toBe(1);
    expect(slots.tryAcquire()).not.toBeNull();
    b!.release();
  });

  it('frees a slot nobody released after the hold limit', () => {
    const slots = new SetupSlots(1, 30_000);
    slots.tryAcquire();
    expect(slots.tryAcquire()).toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(slots.inFlight).toBe(0);
    expect(slots.tryAcquire()).not.toBeNull();
  });
});
