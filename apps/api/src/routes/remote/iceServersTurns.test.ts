import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getIceServers } from './helpers';

const SCOPE = { sessionId: 'sess-1', userId: 'user-1', deviceId: 'dev-1' };

function turnUrls(): string[] {
  const entry = getIceServers(SCOPE).find((s) => Array.isArray(s.urls));
  return (entry?.urls as string[] | undefined) ?? [];
}

describe('getIceServers — TURNS (turns:) advertisement (#6163)', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.TURN_HOST = '203.0.113.10';
    process.env.TURN_SECRET = 'test-secret';
    delete process.env.TURN_TLS_HOST;
    delete process.env.TURN_TLS_PORT;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('advertises only plain turn: URLs when TURN_TLS_HOST is unset', () => {
    const urls = turnUrls();
    expect(urls).toEqual([
      'turn:203.0.113.10:3478?transport=udp',
      'turn:203.0.113.10:3478?transport=tcp',
    ]);
  });

  it('appends a turns: TCP URL on the cert hostname when TURN_TLS_HOST is set', () => {
    process.env.TURN_TLS_HOST = 'turn.example.com';
    expect(turnUrls()).toContain('turns:turn.example.com:5349?transport=tcp');
  });

  it('honours TURN_TLS_PORT', () => {
    process.env.TURN_TLS_HOST = 'turn.example.com';
    process.env.TURN_TLS_PORT = '443';
    expect(turnUrls()).toContain('turns:turn.example.com:443?transport=tcp');
  });

  it('does not advertise turns: when no TURN credentials can be generated', () => {
    process.env.TURN_TLS_HOST = 'turn.example.com';
    delete process.env.TURN_SECRET;
    expect(turnUrls()).toEqual([]);
  });
});
