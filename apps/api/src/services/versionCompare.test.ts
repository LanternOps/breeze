import { describe, it, expect } from 'vitest';
import { compareBuilds, isVersionInRange, isVulnerable } from './versionCompare';

describe('compareBuilds', () => {
  it('orders Office builds numerically, not lexically', () => {
    expect(compareBuilds('16.0.14332.20481', '16.0.14332.20500')).toBe(-1);
    expect(compareBuilds('16.0.9.100', '16.0.14.0')).toBe(-1); // 9 < 14 numerically
  });
  it('orders Windows builds numerically', () => {
    expect(compareBuilds('10.0.22631.4317', '10.0.22631.4391')).toBe(-1);
  });
  it('pads shorter versions with zeros', () => {
    expect(compareBuilds('16.0', '16.0.0.0')).toBe(0);
    expect(compareBuilds('16.0.1', '16.0')).toBe(1);
  });
  it('treats equal builds as 0', () => {
    expect(compareBuilds('1.2.3', '1.2.3')).toBe(0);
  });
});

describe('isVulnerable', () => {
  it('is vulnerable when installed build is below FixedBuild', () => {
    expect(isVulnerable('16.0.14332.20481', '16.0.14332.20500')).toBe(true);
  });
  it('is not vulnerable when installed >= FixedBuild', () => {
    expect(isVulnerable('16.0.14332.20500', '16.0.14332.20500')).toBe(false);
    expect(isVulnerable('16.0.14332.20600', '16.0.14332.20500')).toBe(false);
  });
});

describe('isVersionInRange', () => {
  it('matches inside [start, end)', () => {
    expect(isVersionInRange('20.5', { startIncluding: '20.0', endExcluding: '21.0' })).toBe(true);
  });
  it('excludes the endExcluding bound itself', () => {
    expect(isVersionInRange('21.0', { startIncluding: '20.0', endExcluding: '21.0' })).toBe(false);
  });
  it('includes the endIncluding bound', () => {
    expect(isVersionInRange('21.0', { endIncluding: '21.0' })).toBe(true);
  });
  it('respects startExcluding', () => {
    expect(isVersionInRange('20.0', { startExcluding: '20.0', endExcluding: '21.0' })).toBe(false);
    expect(isVersionInRange('20.1', { startExcluding: '20.0', endExcluding: '21.0' })).toBe(true);
  });
  it('an empty range matches anything (all versions vulnerable)', () => {
    expect(isVersionInRange('1.2.3', {})).toBe(true);
  });
  it('compares numerically not lexically', () => {
    expect(isVersionInRange('9.0', { startIncluding: '8.0', endExcluding: '10.0' })).toBe(true);
  });
});
