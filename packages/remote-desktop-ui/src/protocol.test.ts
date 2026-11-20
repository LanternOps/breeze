import { describe, it, expect } from 'vitest';
import { buildWsUrl, parseDeepLink } from './protocol';

describe('parseDeepLink', () => {
  it('parses breeze://connect URLs', () => {
    const url = 'breeze://connect?session=abc&code=def&api=https%3A%2F%2Fexample.com';
    expect(parseDeepLink(url)).toEqual({
      mode: 'desktop',
      sessionId: 'abc',
      connectCode: 'def',
      apiUrl: 'https://example.com',
    });
  });

  it('parses breeze:connect variant', () => {
    const url = 'breeze:connect?session=s1&code=c1&api=https%3A%2F%2Fexample.com%2Fbase%2F';
    expect(parseDeepLink(url)).toEqual({
      mode: 'desktop',
      sessionId: 's1',
      connectCode: 'c1',
      apiUrl: 'https://example.com/base',
    });
  });

  it('parses breeze://connect/? trailing slash variant', () => {
    const url = 'breeze://connect/?session=s2&code=c2&api=https%3A%2F%2Fexample.com';
    expect(parseDeepLink(url)).toEqual({
      mode: 'desktop',
      sessionId: 's2',
      connectCode: 'c2',
      apiUrl: 'https://example.com',
    });
  });

  it('allows http:// only for localhost/loopback', () => {
    const url = 'breeze://connect?session=s&code=c&api=http%3A%2F%2Flocalhost%3A3000%2F';
    expect(parseDeepLink(url)).toEqual({
      mode: 'desktop',
      sessionId: 's',
      connectCode: 'c',
      apiUrl: 'http://localhost:3000',
    });
  });

  it('rejects non-https apiUrl for non-loopback hosts', () => {
    const url = 'breeze://connect?session=s&code=c&api=http%3A%2F%2Fexample.com';
    expect(parseDeepLink(url)).toBeNull();
  });

  it('rejects HTTP API URLs on RFC1918 addresses', () => {
    const url = 'breeze://connect?session=a&code=b&api=http%3A%2F%2F192.168.1.5';
    expect(parseDeepLink(url)).toBeNull();
  });

  it('rejects HTTP API URLs on 100.* (Tailscale) addresses', () => {
    const url = 'breeze://connect?session=a&code=b&api=http%3A%2F%2F100.100.100.100';
    expect(parseDeepLink(url)).toBeNull();
  });

  it('rejects HTTP API URLs on 10.* addresses', () => {
    const url = 'breeze://connect?session=a&code=b&api=http%3A%2F%2F10.0.0.1';
    expect(parseDeepLink(url)).toBeNull();
  });

  it('accepts HTTP API URLs on 127.0.0.1', () => {
    const url = 'breeze://connect?session=a&code=b&api=http%3A%2F%2F127.0.0.1%3A3000';
    expect(parseDeepLink(url)).not.toBeNull();
  });

  it('accepts HTTP API URLs on [::1] (IPv6 loopback)', () => {
    const url = 'breeze://connect?session=a&code=b&api=http%3A%2F%2F%5B%3A%3A1%5D';
    expect(parseDeepLink(url)).not.toBeNull();
  });

  it('returns null when required params are missing', () => {
    expect(parseDeepLink('breeze://connect?session=abc')).toBeNull();
  });

  it('parses optional device param', () => {
    const url = 'breeze://connect?session=abc&code=def&api=https%3A%2F%2Fexample.com&device=dev-123';
    expect(parseDeepLink(url)).toEqual({
      mode: 'desktop',
      sessionId: 'abc',
      connectCode: 'def',
      apiUrl: 'https://example.com',
      deviceId: 'dev-123',
    });
  });

  it('omits deviceId when device param is absent', () => {
    const url = 'breeze://connect?session=abc&code=def&api=https%3A%2F%2Fexample.com';
    const result = parseDeepLink(url);
    expect(result).not.toBeNull();
    expect(result!).not.toHaveProperty('deviceId');
  });

  it('omits deviceId when device param is empty', () => {
    const url = 'breeze://connect?session=abc&code=def&api=https%3A%2F%2Fexample.com&device=';
    const result = parseDeepLink(url);
    expect(result).not.toBeNull();
    expect(result!).not.toHaveProperty('deviceId');
  });
});

describe('parseDeepLink — VNC', () => {
  it('parses a breeze://vnc URL with all required params (code-based)', () => {
    const url = 'breeze://vnc?tunnel=tun-1' +
                '&device=dev-1&api=' + encodeURIComponent('https://api.example.com') +
                '&code=abc123xyz';
    expect(parseDeepLink(url)).toEqual({
      mode: 'vnc',
      tunnelId: 'tun-1',
      deviceId: 'dev-1',
      apiUrl: 'https://api.example.com',
      code: 'abc123xyz',
    });
  });

  it('returns null when any required VNC param is missing', () => {
    expect(parseDeepLink('breeze://vnc?tunnel=tun-1')).toBeNull();
    expect(parseDeepLink('breeze://vnc?tunnel=tun-1&device=d&api=https%3A%2F%2Fx')).toBeNull(); // missing code
    expect(parseDeepLink('breeze://vnc?tunnel=tun-1&device=d&code=xyz')).toBeNull(); // missing api
  });

  it('returns null when api is http and host is not private', () => {
    const url = 'breeze://vnc?tunnel=t&device=d&api=' + encodeURIComponent('http://api.example.com') + '&code=tok';
    expect(parseDeepLink(url)).toBeNull();
  });

  it('accepts api=http://localhost for development', () => {
    const url = 'breeze://vnc?tunnel=t' +
                '&device=d&api=' + encodeURIComponent('http://localhost:3000') +
                '&code=tok';
    const p = parseDeepLink(url);
    expect(p?.mode).toBe('vnc');
  });

  it('does not include wsUrl or accessToken in parsed params', () => {
    const url = 'breeze://vnc?tunnel=tun-1&device=dev-1&api=' + encodeURIComponent('https://api.example.com') + '&code=xyz';
    const p = parseDeepLink(url);
    expect(p).not.toBeNull();
    if (p?.mode === 'vnc') {
      expect(p).not.toHaveProperty('wsUrl');
      expect(p).not.toHaveProperty('accessToken');
    }
  });
});

describe('parseDeepLink — desktop (existing behavior preserved)', () => {
  it('returns mode:desktop for breeze://connect', () => {
    const url = 'breeze://connect?session=s1&code=c1&api=' + encodeURIComponent('https://api.example.com');
    const p = parseDeepLink(url);
    expect(p?.mode).toBe('desktop');
    if (p?.mode === 'desktop') {
      expect(p.sessionId).toBe('s1');
      expect(p.connectCode).toBe('c1');
    }
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
