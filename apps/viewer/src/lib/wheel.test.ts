import { describe, it, expect } from 'vitest';
import { DEFAULT_WHEEL_ACCUMULATOR, wheelDeltaToSteps } from './wheel';

describe('wheelDeltaToSteps', () => {
  it('accumulates pixel deltas and emits steps when threshold is crossed', () => {
    let acc = DEFAULT_WHEEL_ACCUMULATOR;

    let r1 = wheelDeltaToSteps(acc, 40, 0);
    expect(r1.steps).toBe(0);
    acc = r1.acc;

    let r2 = wheelDeltaToSteps(acc, 60, 0);
    expect(r2.steps).toBe(1);
    acc = r2.acc;

    // remainder should reset to 0 after exactly 100px
    expect(acc.pixelRemainder).toBe(0);
  });

  it('handles negative pixel deltas', () => {
    let acc = DEFAULT_WHEEL_ACCUMULATOR;
    const r = wheelDeltaToSteps(acc, -120, 0);
    expect(r.steps).toBe(-1);
  });

  it('treats line mode as already in steps', () => {
    const r = wheelDeltaToSteps(DEFAULT_WHEEL_ACCUMULATOR, 3, 1);
    expect(r.steps).toBe(3);
  });

  it('treats page mode as 10 steps per page', () => {
    const r = wheelDeltaToSteps(DEFAULT_WHEEL_ACCUMULATOR, 1, 2);
    expect(r.steps).toBe(10);
  });
});

