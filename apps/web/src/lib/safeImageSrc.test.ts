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

  // Data URI cases
  it('accepts a valid PNG data URI within the size limit', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    expect(sanitizeImageSrc(dataUri)).toBe(dataUri);
  });

  it('accepts a valid JPEG data URI', () => {
    const dataUri = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARC';
    expect(sanitizeImageSrc(dataUri)).toBe(dataUri);
  });

  it('accepts a valid WebP data URI', () => {
    const dataUri = 'data:image/webp;base64,UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoBAAEAAkA4JYgCdAEO/gHOAAA=';
    expect(sanitizeImageSrc(dataUri)).toBe(dataUri);
  });

  it('rejects SVG data URI (XSS risk)', () => {
    expect(sanitizeImageSrc('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull();
  });

  it('rejects HTML data URI', () => {
    expect(sanitizeImageSrc('data:text/html;base64,PGh0bWwv>')).toBeNull();
  });

  it('rejects a data URI that exceeds the size limit', () => {
    const oversized = 'data:image/png;base64,' + 'A'.repeat(400_001);
    expect(sanitizeImageSrc(oversized)).toBeNull();
  });

  it('rejects a data URI without the base64 marker', () => {
    expect(sanitizeImageSrc('data:image/png,rawbytes')).toBeNull();
  });

  it('rejects a data URI with no base64 payload', () => {
    expect(sanitizeImageSrc('data:image/png;base64,')).toBeNull();
  });

  it('accepts a data URI of exactly 400,000 characters', () => {
    const prefix = 'data:image/png;base64,';
    const uri = prefix + 'A'.repeat(400_000 - prefix.length);
    expect(uri.length).toBe(400_000);
    expect(sanitizeImageSrc(uri)).toBe(uri);
  });

  it('rejects a data URI of exactly 400,001 characters', () => {
    const prefix = 'data:image/png;base64,';
    const uri = prefix + 'A'.repeat(400_001 - prefix.length);
    expect(uri.length).toBe(400_001);
    expect(sanitizeImageSrc(uri)).toBeNull();
  });

  it('rejects uppercase MIME type variants (case-sensitive by design)', () => {
    // The allowlist is lowercase-only; browsers accept mixed-case but we intentionally reject
    // to avoid any ambiguity in the allowlist (applies to data: URIs only; https: URLs are not filtered by MIME type).
    expect(sanitizeImageSrc('data:image/PNG;base64,AAAA')).toBeNull();
    expect(sanitizeImageSrc('data:image/JPEG;base64,AAAA')).toBeNull();
    expect(sanitizeImageSrc('data:image/WebP;base64,AAAA')).toBeNull();
  });
});
