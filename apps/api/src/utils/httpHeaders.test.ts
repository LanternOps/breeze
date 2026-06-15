import { describe, it, expect } from 'vitest';
import { safeContentDispositionFilename } from './httpHeaders';

describe('safeContentDispositionFilename', () => {
  it('strips CR/LF and escapes quotes to block header injection', () => {
    // Partner-controlled invoice number attempting to inject a header.
    expect(safeContentDispositionFilename('INV"\r\nX-Evil: 1')).toBe('INV\\"X-Evil: 1');
  });

  it('escapes backslashes', () => {
    expect(safeContentDispositionFilename('a\\b')).toBe('a\\\\b');
  });

  it('leaves a normal invoice number untouched', () => {
    expect(safeContentDispositionFilename('INV-2026-0042')).toBe('INV-2026-0042');
  });

  it('removes both carriage return and line feed', () => {
    expect(safeContentDispositionFilename('a\rb\nc')).toBe('abc');
  });
});
