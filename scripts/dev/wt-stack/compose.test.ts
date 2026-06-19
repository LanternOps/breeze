import { describe, it, expect } from 'vitest';
import { parsePublishedPort } from './compose';

describe('parsePublishedPort', () => {
  it('parses an IPv4 mapping', () => {
    expect(parsePublishedPort('0.0.0.0:53421\n')).toBe(53421);
  });
  it('parses the first line when both IPv6 and IPv4 are present', () => {
    expect(parsePublishedPort('[::]:53421\n0.0.0.0:53421\n')).toBe(53421);
  });
  it('throws on empty output', () => {
    expect(() => parsePublishedPort('   \n')).toThrow(/no published port/i);
  });
});
