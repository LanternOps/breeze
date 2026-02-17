import { describe, expect, it } from 'vitest';

import { sanitizeImageSrc } from './safeImageSrc';

describe('sanitizeImageSrc', () => {
  it('allows blob URLs', () => {
    expect(sanitizeImageSrc('blob:https://app.example.com/abc123')).toBe('blob:https://app.example.com/abc123');
  });

  it('allows safe relative paths', () => {
    expect(sanitizeImageSrc('/uploads/logo.png')).toBe('/uploads/logo.png');
  });

  it('allows https URLs', () => {
    expect(sanitizeImageSrc('https://cdn.example.com/logo.svg')).toBe('https://cdn.example.com/logo.svg');
  });

  it('allows http URLs', () => {
    expect(sanitizeImageSrc('http://localhost:3001/logo.png')).toBe('http://localhost:3001/logo.png');
    expect(sanitizeImageSrc('http://127.0.0.1:8080/logo.png')).toBe('http://127.0.0.1:8080/logo.png');
    expect(sanitizeImageSrc('http://cdn.example.com/logo.png')).toBe('http://cdn.example.com/logo.png');
  });

  it('rejects dangerous and unsupported schemes', () => {
    expect(sanitizeImageSrc('javascript:alert(1)')).toBeNull();
    expect(sanitizeImageSrc('data:text/html,<svg/onload=alert(1)>')).toBeNull();
    expect(sanitizeImageSrc('ftp://example.com/logo.png')).toBeNull();
  });

  it('rejects protocol-relative and malformed relative paths', () => {
    expect(sanitizeImageSrc('//evil.example/logo.png')).toBeNull();
    expect(sanitizeImageSrc('/\\evil.example/logo.png')).toBeNull();
  });

  it('rejects empty and control-character inputs', () => {
    expect(sanitizeImageSrc('')).toBeNull();
    expect(sanitizeImageSrc('  ')).toBeNull();
    expect(sanitizeImageSrc('/logo.png\u0000')).toBeNull();
  });
});
