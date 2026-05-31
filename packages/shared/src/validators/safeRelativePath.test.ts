import { describe, expect, it } from 'vitest';
import {
  isSafeRelativePath,
  toSafeRelativePath,
  safeRelativePathSchema,
} from './safeRelativePath';

// These cases mirror the client-side getSafeNext guard
// (apps/web/src/lib/authNext.ts) so a value that would be stripped at
// navigation time can never be persisted server-side in the first place.

describe('isSafeRelativePath', () => {
  it('accepts single-leading-slash relative paths', () => {
    expect(isSafeRelativePath('/')).toBe(true);
    expect(isSafeRelativePath('/devices')).toBe(true);
    expect(isSafeRelativePath('/alerts/123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isSafeRelativePath('/oauth/consent?uid=abc')).toBe(true);
    expect(isSafeRelativePath('/settings#section')).toBe(true);
  });

  it('passes through percent-encoded sequences (browsers do not decode %2F as a separator)', () => {
    expect(isSafeRelativePath('/%2F%2Fevil.com')).toBe(true);
    expect(isSafeRelativePath('/%5cevil.com')).toBe(true);
  });

  it('rejects empty, null, undefined, and non-string values', () => {
    expect(isSafeRelativePath('')).toBe(false);
    expect(isSafeRelativePath(null)).toBe(false);
    expect(isSafeRelativePath(undefined)).toBe(false);
    expect(isSafeRelativePath(42)).toBe(false);
    expect(isSafeRelativePath({})).toBe(false);
    expect(isSafeRelativePath(['/devices'])).toBe(false);
  });

  it('rejects protocol-relative URLs (//evil.com)', () => {
    expect(isSafeRelativePath('//evil.com')).toBe(false);
    expect(isSafeRelativePath('//evil.com/path')).toBe(false);
  });

  it('rejects the backslash host bypass (browsers may normalize \\ to /)', () => {
    expect(isSafeRelativePath('/\\evil.com')).toBe(false);
    expect(isSafeRelativePath('/\\\\evil.com')).toBe(false);
  });

  it('rejects absolute URLs and dangerous schemes', () => {
    expect(isSafeRelativePath('https://evil.com')).toBe(false);
    expect(isSafeRelativePath('http://evil.com')).toBe(false);
    expect(isSafeRelativePath('javascript:alert(1)')).toBe(false);
    expect(isSafeRelativePath('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isSafeRelativePath('data:text/html,<script>')).toBe(false);
  });

  it('rejects bare relative paths with no leading slash', () => {
    expect(isSafeRelativePath('devices')).toBe(false);
    expect(isSafeRelativePath('relative/path')).toBe(false);
  });

  it('rejects control characters anywhere in the path (CR/LF/tab/NUL/DEL)', () => {
    expect(isSafeRelativePath('/foo\r\nLocation: x')).toBe(false);
    expect(isSafeRelativePath('/foo\tbar')).toBe(false);
    expect(isSafeRelativePath('/foo\x00bar')).toBe(false);
    expect(isSafeRelativePath('/foo\x7Fbar')).toBe(false);
  });
});

describe('toSafeRelativePath', () => {
  it('returns the value unchanged when it is a safe relative path', () => {
    expect(toSafeRelativePath('/devices', '/fallback')).toBe('/devices');
    expect(toSafeRelativePath('/alerts/1?x=2#y', '/fallback')).toBe('/alerts/1?x=2#y');
  });

  it('returns the fallback for empty/null/undefined input', () => {
    expect(toSafeRelativePath('', '/alerts/1')).toBe('/alerts/1');
    expect(toSafeRelativePath(null, '/alerts/1')).toBe('/alerts/1');
    expect(toSafeRelativePath(undefined, '/alerts/1')).toBe('/alerts/1');
  });

  it('returns the fallback for hostile inputs', () => {
    expect(toSafeRelativePath('https://evil.com', '/alerts/1')).toBe('/alerts/1');
    expect(toSafeRelativePath('//evil.com', '/alerts/1')).toBe('/alerts/1');
    expect(toSafeRelativePath('/\\evil.com', '/alerts/1')).toBe('/alerts/1');
    expect(toSafeRelativePath('javascript:alert(1)', '/alerts/1')).toBe('/alerts/1');
    expect(toSafeRelativePath('/x\r\ny', '/alerts/1')).toBe('/alerts/1');
  });
});

describe('safeRelativePathSchema', () => {
  it('accepts safe relative paths', () => {
    expect(safeRelativePathSchema.safeParse('/devices').success).toBe(true);
    expect(safeRelativePathSchema.safeParse('/').success).toBe(true);
  });

  it('rejects unsafe values', () => {
    for (const value of [
      '',
      '//evil.com',
      '/\\evil.com',
      'https://evil.com',
      'javascript:alert(1)',
      'relative/path',
      '/with\nnewline',
    ]) {
      expect(safeRelativePathSchema.safeParse(value).success).toBe(false);
    }
  });
});
