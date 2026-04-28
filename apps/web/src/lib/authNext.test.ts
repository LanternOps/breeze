import { describe, it, expect } from 'vitest';
import { getSafeNext } from './authNext';

describe('getSafeNext', () => {
  it('returns fallback when input is null/undefined/empty', () => {
    expect(getSafeNext(null)).toBe('/');
    expect(getSafeNext(undefined)).toBe('/');
    expect(getSafeNext('')).toBe('/');
  });

  it('accepts relative paths starting with a single slash', () => {
    expect(getSafeNext('/devices')).toBe('/devices');
    expect(getSafeNext('/oauth/consent?uid=abc')).toBe('/oauth/consent?uid=abc');
  });

  it('rejects protocol-relative URLs (//evil.com)', () => {
    expect(getSafeNext('//evil.com')).toBe('/');
    expect(getSafeNext('//evil.com/path')).toBe('/');
  });

  it('rejects absolute URLs (http/https/javascript)', () => {
    expect(getSafeNext('https://evil.com')).toBe('/');
    expect(getSafeNext('http://evil.com')).toBe('/');
    expect(getSafeNext('javascript:alert(1)')).toBe('/');
  });

  it('respects a custom fallback', () => {
    expect(getSafeNext(null, '/dashboard')).toBe('/dashboard');
    expect(getSafeNext('https://evil.com', '/dashboard')).toBe('/dashboard');
  });
});
