import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const keyState = vi.hoisted(() => ({
  active: { keyId: 'current', key: Buffer.alloc(32, 0x11) },
  retained: [
    { keyId: 'current', key: Buffer.alloc(32, 0x11) },
    { keyId: 'old', key: Buffer.alloc(32, 0x22) },
  ],
}));

vi.mock('./secretCrypto', () => ({
  getSecretDerivedKeyMaterials: vi.fn(() => keyState),
}));

import {
  issueTerminalLogoutTicket,
  verifyTerminalLogoutTicket,
  type TerminalLogoutTicketClaims,
} from './terminalLogoutTicket';

const claims: TerminalLogoutTicketClaims = Object.freeze({
  version: 1,
  audience: 'terminal-logout-completion',
  transitionId: '11111111-1111-4111-8111-111111111111',
  logoutId: '22222222-2222-4222-8222-222222222222',
  generation: 7,
  nonce: 'ab'.repeat(32),
  issuedAt: 1_800_000_000,
  expiresAt: 1_800_000_300,
});

describe('terminal logout completion tickets', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(claims.issuedAt * 1000));
  });

  it('round-trips the exact canonical claims and identifies the signing key', () => {
    const ticket = issueTerminalLogoutTicket(claims);

    expect(verifyTerminalLogoutTicket(ticket)).toEqual({
      claims,
      signingKeyId: 'current',
    });
  });

  it('accepts a ticket signed by a retained rotation key', () => {
    const currentTicket = issueTerminalLogoutTicket(claims);
    const [, payload] = currentTicket.split('.');
    if (!payload) throw new Error('ticket payload missing');
    const signature = createHmac('sha256', keyState.retained[1]!.key)
      .update(`terminal-logout-ticket:v1:${payload}`)
      .digest('base64url');

    expect(verifyTerminalLogoutTicket(`v1.${payload}.${signature}`)).toEqual({
      claims,
      signingKeyId: 'old',
    });
  });

  it('rejects a forged signature before parsing authority fields', () => {
    const ticket = issueTerminalLogoutTicket(claims);
    const [, payload] = ticket.split('.');
    const forgedPayload = Buffer.from('{not-json', 'utf8').toString('base64url');

    expect(verifyTerminalLogoutTicket(`v1.${forgedPayload}.${ticket.split('.')[2]}`)).toBeNull();
    expect(verifyTerminalLogoutTicket(`v1.${payload}.${'AA'.repeat(32)}`)).toBeNull();
  });

  it('rejects non-canonical base64url encodings even when correctly signed', () => {
    const [, canonicalPayload] = issueTerminalLogoutTicket(claims).split('.');
    if (!canonicalPayload) throw new Error('ticket payload missing');
    const paddedPayload = `${canonicalPayload}=`;
    const paddedSignature = createHmac('sha256', keyState.active.key)
      .update(`terminal-logout-ticket:v1:${paddedPayload}`)
      .digest('base64url');

    expect(verifyTerminalLogoutTicket(`v1.${paddedPayload}.${paddedSignature}`)).toBeNull();
  });

  it.each([
    ['wrong audience', { audience: 'somewhere-else' }],
    ['wrong version', { version: 2 }],
    ['invalid transition id', { transitionId: 'not-a-uuid' }],
    ['invalid logout id', { logoutId: 'not-a-uuid' }],
    ['zero generation', { generation: 0 }],
    ['invalid nonce', { nonce: 'raw-secret' }],
    ['non-increasing expiry', { expiresAt: claims.issuedAt }],
  ])('rejects signed claims with %s', (_label, patch) => {
    const invalid = { ...claims, ...patch } as TerminalLogoutTicketClaims;
    expect(() => issueTerminalLogoutTicket(invalid)).toThrow();
  });

  it('rejects an expired ticket using server time', () => {
    const ticket = issueTerminalLogoutTicket(claims);
    vi.setSystemTime(new Date((claims.expiresAt + 1) * 1000));
    expect(verifyTerminalLogoutTicket(ticket)).toBeNull();
  });
});
