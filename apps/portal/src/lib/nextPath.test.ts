import { describe, it, expect } from 'vitest';
import { safeNextPath } from './nextPath';

describe('safeNextPath', () => {
  it.each([
    ['/invoices', '/invoices'],
    ['/invoices/abc-123', '/invoices/abc-123'],
    ['/quotes/abc-123', '/quotes/abc-123'],
    ['/tickets/9', '/tickets/9'],
    ['/profile', '/profile'],
    ['/invoices/abc?paid=1', '/invoices/abc?paid=1'],
  ])('accepts in-app route %j', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it('decodes a percent-encoded value once', () => {
    expect(safeNextPath('%2Finvoices%2Fabc')).toBe('/invoices/abc');
  });

  // Open-redirect is the whole reason this helper exists.
  it.each([
    'https://evil.test/x',
    'http://evil.test',
    '//evil.test',
    '/\\evil.test',
    'javascript:alert(1)',
    'mailto:a@b.test',
    '/invoices\\@evil.test',
    '/ /invoices',
    '/\u0009/invoices',
  ])('rejects off-origin or malformed %j', (input) => {
    expect(safeNextPath(input)).toBeNull();
  });

  it.each(['/', '/login', '/admin', '/quotesfoo', '/invoices/../../etc'])(
    'rejects path outside the allowlist %j',
    (input) => {
      expect(safeNextPath(input)).toBeNull();
    }
  );

  it.each([null, undefined, '', '   '])('rejects empty %j', (input) => {
    expect(safeNextPath(input as string)).toBeNull();
  });

  it('rejects a malformed percent-escape rather than throwing', () => {
    expect(safeNextPath('/invoices/%E0%A4%A')).toBeNull();
  });
});
