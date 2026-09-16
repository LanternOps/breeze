import { describe, expect, it } from 'vitest';
import { compareTopologySequences } from './sequence';
describe('unsigned topology producer sequences', () => {
  it.each([['9','10'],['9007199254740991','9007199254740992'],['9223372036854775807','9223372036854775808'],['9223372036854775808','18446744073709551615']])('compares %s below %s without loss', (a,b) => {
    expect(compareTopologySequences(a,b)).toBe(-1);
    expect(compareTopologySequences(b,a)).toBe(1);
    expect(compareTopologySequences(a,a)).toBe(0);
  });
  it.each(['-1','1.1','01','1e2','18446744073709551616'])('rejects %s before SQL', value => {
    expect(() => compareTopologySequences(value,'0')).toThrow();
  });
});
