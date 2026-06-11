import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema', () => ({
  tunnelSessions: {},
  devices: {},
  users: {},
}));

vi.mock('../services/remoteSessionAuth', () => ({
  consumeWsTicket: vi.fn(),
}));

vi.mock('./agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn(async () => ({ allowed: true })),
}));

vi.mock('../services/viewerTokenRevocation', () => ({
  revokeViewerSession: vi.fn(async () => undefined),
}));

import { validateTunnelTextRelayFrame } from './tunnelWs';

describe('validateTunnelTextRelayFrame', () => {
  it('accepts base64 data within the binary frame cap', () => {
    const encoded = Buffer.from('hello').toString('base64');
    const result = validateTunnelTextRelayFrame(JSON.stringify({ type: 'data', data: encoded }));

    expect(result).toEqual({ ok: true, data: encoded });
  });

  it('rejects malformed base64 text relay data', () => {
    const result = validateTunnelTextRelayFrame(JSON.stringify({ type: 'data', data: 'not base64!' }));

    expect(result.ok).toBe(false);
  });

  it('rejects decoded data larger than the binary frame cap', () => {
    const encoded = Buffer.from(new Uint8Array(1_000_001)).toString('base64');
    const result = validateTunnelTextRelayFrame(JSON.stringify({ type: 'data', data: encoded }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/decoded|encoded/i);
    }
  });
});
