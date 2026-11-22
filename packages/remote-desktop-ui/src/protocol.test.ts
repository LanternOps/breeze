import { describe, it, expect } from 'vitest';
import { buildWsUrl } from './protocol';

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
