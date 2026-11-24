import { describe, expect, it } from 'vitest';
import { planSiteLocks } from './siteLock';

describe('planSiteLocks', () => {
  it('plans one lock per distinct site, ascending', () => {
    expect(planSiteLocks(['c3', 'a1', 'c3', 'b2'])).toEqual(['a1', 'b2', 'c3']);
    expect(planSiteLocks([])).toEqual([]);
  });
});
