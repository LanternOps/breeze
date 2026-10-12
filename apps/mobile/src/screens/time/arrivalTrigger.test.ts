import { describe, expect, it, vi } from 'vitest';

import { requestArrivalCheck, subscribeArrivalCheck, isArrivalTab } from './arrivalTrigger';

describe('arrival trigger bus', () => {
  it('delivers the manual flag to subscribers and stops after unsubscribe', () => {
    const fn = vi.fn();
    const off = subscribeArrivalCheck(fn);
    requestArrivalCheck();
    requestArrivalCheck(true);
    expect(fn.mock.calls).toEqual([[false], [true]]);
    off();
    requestArrivalCheck();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a throwing subscriber does not stop the others', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const offBad = subscribeArrivalCheck(bad);
    const offGood = subscribeArrivalCheck(good);
    expect(() => requestArrivalCheck()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    offBad();
    offGood();
  });

  it('only the Home and Tickets tabs count as arrival-check focus', () => {
    expect(isArrivalTab('HomeTab')).toBe(true);
    expect(isArrivalTab('TicketsTab')).toBe(true);
    expect(isArrivalTab('TimeTab')).toBe(false);
    expect(isArrivalTab('SystemsTab')).toBe(false);
  });
});
