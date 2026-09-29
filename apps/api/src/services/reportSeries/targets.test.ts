import { describe, expect, it } from 'vitest';
import { applyTargetMode } from './targets';

const eligible = ['a', 'b', 'c'];

describe('applyTargetMode', () => {
  it("'all' is every eligible org minus the exclusion rows", () => {
    expect(applyTargetMode(eligible, 'all', new Set(['b']))).toEqual(['a', 'c']);
  });
  it("'selected' is exactly the listed eligible orgs", () => {
    expect(applyTargetMode(eligible, 'selected', new Set(['b', 'c']))).toEqual(['b', 'c']);
  });
  it('a listed org that is not eligible is never targeted in either mode', () => {
    expect(applyTargetMode(eligible, 'selected', new Set(['z']))).toEqual([]);
    expect(applyTargetMode(eligible, 'all', new Set(['z']))).toEqual(eligible);
  });
});
