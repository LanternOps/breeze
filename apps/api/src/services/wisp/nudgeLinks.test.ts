import { describe, expect, it } from 'vitest';
import { mobileDeepLink, parseWispDeepLink, webDeepLink } from './nudgeLinks';

const T = '3f2a1c9e-7b4d-4e8f-9a01-2b3c4d5e6f70';
const C = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe('nudgeLinks', () => {
  it('builds the mobile link with and without a concern', () => {
    expect(mobileDeepLink('t1', 'c1')).toBe('breeze://wisp/thread/t1?concern=c1');
    expect(mobileDeepLink('t1', null)).toBe('breeze://wisp/thread/t1');
  });

  it('builds the web link with the concern in the hash', () => {
    expect(webDeepLink('t1', null)).toBe('/ai/wisp/thread/t1');
    expect(webDeepLink('t1', 'c1')).toBe('/ai/wisp/thread/t1#concern=c1');
  });

  it('the web link satisfies the user_notifications relative-link CHECK', () => {
    const link = webDeepLink(T, C);
    expect(link.startsWith('/')).toBe(true);
    expect(link.startsWith('//')).toBe(false);
  });

  it('parses both forms and rejects anything else', () => {
    expect(parseWispDeepLink('breeze://wisp/thread/t1?concern=c1')).toEqual({ threadId: 't1', concernId: 'c1' });
    expect(parseWispDeepLink('/ai/wisp/thread/t1#concern=c1')).toEqual({ threadId: 't1', concernId: 'c1' });
    expect(parseWispDeepLink('/ai/wisp/thread/t1')).toEqual({ threadId: 't1', concernId: null });
    expect(parseWispDeepLink('breeze://wisp/thread/t1')).toEqual({ threadId: 't1', concernId: null });
    expect(parseWispDeepLink('/tickets/1')).toBeNull();
    expect(parseWispDeepLink('breeze://wisp/thread/')).toBeNull();
    expect(parseWispDeepLink('')).toBeNull();
  });

  it('round-trips uuid ids through both forms', () => {
    expect(parseWispDeepLink(mobileDeepLink(T, C))).toEqual({ threadId: T, concernId: C });
    expect(parseWispDeepLink(webDeepLink(T, C))).toEqual({ threadId: T, concernId: C });
    expect(parseWispDeepLink(webDeepLink(T, null))).toEqual({ threadId: T, concernId: null });
  });

  it('rejects path smuggling and foreign hosts', () => {
    expect(parseWispDeepLink('/ai/wisp/thread/t1/../../admin')).toBeNull();
    expect(parseWispDeepLink('https://evil.example/ai/wisp/thread/t1')).toBeNull();
    expect(parseWispDeepLink('breeze://other/thread/t1')).toBeNull();
    expect(parseWispDeepLink('/ai/wisp/thread/t%2F1')).toBeNull();
  });
});
