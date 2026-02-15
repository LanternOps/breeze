import { describe, it, expect } from 'vitest';
import { buildWsUrl, parseDeepLink } from './protocol';

describe('parseDeepLink', () => {
  it('parses breeze://connect URLs', () => {
    const url = 'breeze://connect?session=abc&code=def&api=https%3A%2F%2Fexample.com';
    expect(parseDeepLink(url)).toEqual({
      sessionId: 'abc',
      connectCode: 'def',
      apiUrl: 'https://example.com',
    });
  });

  it('parses breeze:connect variant', () => {
    const url = 'breeze:connect?session=s1&code=c1&api=https%3A%2F%2Fexample.com%2Fbase%2F';
    expect(parseDeepLink(url)).toEqual({
      sessionId: 's1',
      connectCode: 'c1',
      apiUrl: 'https://example.com/base',
    });
  });

  it('parses breeze://connect/? trailing slash variant', () => {
    const url = 'breeze://connect/?session=s2&code=c2&api=https%3A%2F%2Fexample.com';
    expect(parseDeepLink(url)).toEqual({
      sessionId: 's2',
      connectCode: 'c2',
      apiUrl: 'https://example.com',
    });
  });

  it('allows http:// only for localhost/loopback', () => {
    const url = 'breeze://connect?session=s&code=c&api=http%3A%2F%2Flocalhost%3A3000%2F';
    expect(parseDeepLink(url)).toEqual({
      sessionId: 's',
      connectCode: 'c',
      apiUrl: 'http://localhost:3000',
    });
  });

  it('rejects non-https apiUrl for non-loopback hosts', () => {
    const url = 'breeze://connect?session=s&code=c&api=http%3A%2F%2Fexample.com';
    expect(parseDeepLink(url)).toBeNull();
  });

  it('returns null when required params are missing', () => {
    expect(parseDeepLink('breeze://connect?session=abc')).toBeNull();
  });
});

describe('buildWsUrl', () => {
  it('builds wss:// URL from https base', () => {
    const wsUrl = buildWsUrl('https://example.com', 'sess', 'ticket');
    expect(wsUrl).toBe('wss://example.com/api/v1/desktop-ws/sess/ws?ticket=ticket');
  });

  it('preserves base path prefix', () => {
    const wsUrl = buildWsUrl('https://example.com/base', 'sess', 'ticket');
    expect(wsUrl).toBe('wss://example.com/base/api/v1/desktop-ws/sess/ws?ticket=ticket');
  });

  it('builds ws:// URL from http base', () => {
    const wsUrl = buildWsUrl('http://localhost:3000', 'sess', 'ticket');
    expect(wsUrl).toBe('ws://localhost:3000/api/v1/desktop-ws/sess/ws?ticket=ticket');
  });

  it('encodes ticket via query params', () => {
    const wsUrl = buildWsUrl('https://example.com', 'sess', 'a b&c');
    const u = new URL(wsUrl);
    expect(u.searchParams.get('ticket')).toBe('a b&c');
  });
});

