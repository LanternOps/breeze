import { describe, expect, it } from 'vitest';
import { isSafeHttpUrl } from './safeMarkdownLinks';

describe('isSafeHttpUrl', () => {
  it.each(['https://example.com/x.png', 'http://example.com/x.png'])('accepts %s', (url) => {
    expect(isSafeHttpUrl(url)).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    '//example.com/x.png',
    '/relative.png',
    'file:///etc/passwd',
  ])('rejects %s', (url) => {
    expect(isSafeHttpUrl(url as string | undefined | null)).toBe(false);
  });
});
