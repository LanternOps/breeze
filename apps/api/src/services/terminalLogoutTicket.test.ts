import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createTerminalLogoutTicketService,
  TerminalLogoutTicketInvalidError,
} from './terminalLogoutTicket';

const signingKey = Buffer.from('11'.repeat(32), 'hex');
const service = createTerminalLogoutTicketService(() => ({
  active: { keyId: 'active', key: signingKey },
  retained: [{ keyId: 'active', key: signingKey }],
}));

const issuedAt = new Date('2026-07-13T12:00:00.000Z');
const expiresAt = new Date('2026-07-13T12:10:00.000Z');
const validInput = {
  transitionId: '11111111-1111-4111-8111-111111111111',
  logoutId: '22222222-2222-4222-8222-222222222222',
  generation: 7,
  nonce: 'ab'.repeat(32),
  issuedAt,
  expiresAt,
} as const;

function resignPayload(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', signingKey).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function decodedPayload(ticket: string): Record<string, unknown> {
  const [encoded] = ticket.split('.');
  return JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('terminal logout completion ticket', () => {
  it('round-trips exactly the approved authority fields', () => {
    const ticket = service.issue(validInput);

    expect(service.verify(ticket, new Date('2026-07-13T12:05:00.000Z'))).toEqual({
      version: 1,
      audience: 'terminal-logout-completion',
      transitionId: validInput.transitionId,
      logoutId: validInput.logoutId,
      generation: validInput.generation,
      nonce: validInput.nonce,
      issuedAt: issuedAt.getTime(),
      expiresAt: expiresAt.getTime(),
      signingKeyId: 'active',
    });
    expect(Object.keys(decodedPayload(ticket)).sort()).toEqual([
      'audience',
      'expiresAt',
      'generation',
      'issuedAt',
      'logoutId',
      'nonce',
      'transitionId',
      'version',
    ]);
  });

  it('requires a 256-bit lowercase hexadecimal nonce', () => {
    for (const nonce of ['ab', 'AB'.repeat(32), 'g0'.repeat(32), 'ab'.repeat(31)]) {
      expect(() => service.issue({ ...validInput, nonce })).toThrow(TerminalLogoutTicketInvalidError);
    }
  });

  it('rejects an altered signature before accepting authority fields', () => {
    const ticket = service.issue(validInput);
    const [payload, signature] = ticket.split('.');
    const altered = `${payload}.${signature!.slice(0, -1)}${signature!.endsWith('A') ? 'B' : 'A'}`;

    expect(() => service.verify(altered, issuedAt)).toThrow(TerminalLogoutTicketInvalidError);
  });

  it.each([
    ['audience', 'other-audience'],
    ['version', 2],
    ['transitionId', '33333333-3333-4333-8333-333333333333'],
    ['logoutId', '44444444-4444-4444-8444-444444444444'],
    ['generation', 8],
    ['nonce', 'cd'.repeat(32)],
  ])('rejects signature-preserving alteration of %s', (field, value) => {
    const ticket = service.issue(validInput);
    const [, signature] = ticket.split('.');
    const payload = decodedPayload(ticket);
    payload[field] = value;
    const alteredPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    expect(() => service.verify(`${alteredPayload}.${signature}`, issuedAt)).toThrow(
      TerminalLogoutTicketInvalidError,
    );
  });

  it.each([
    ['audience', 'other-audience'],
    ['version', 2],
  ])('rejects a validly signed unsupported %s', (field, value) => {
    const payload = decodedPayload(service.issue(validInput));
    payload[field] = value;
    expect(() => service.verify(resignPayload(payload), issuedAt)).toThrow(
      TerminalLogoutTicketInvalidError,
    );
  });

  it('rejects an expired ticket', () => {
    const ticket = service.issue(validInput);
    for (const now of [expiresAt, new Date(expiresAt.getTime() + 1)]) {
      expect(() => service.verify(ticket, now)).toThrow(TerminalLogoutTicketInvalidError);
    }
  });

  it('verifies a pre-rotation ticket with its retained key and returns the old signing key id', () => {
    const oldKey = Buffer.from('22'.repeat(32), 'hex');
    const newKey = Buffer.from('33'.repeat(32), 'hex');
    const oldService = createTerminalLogoutTicketService(() => ({
      active: { keyId: 'old', key: oldKey },
      retained: [{ keyId: 'old', key: oldKey }],
    }));
    const rotatedService = createTerminalLogoutTicketService(() => ({
      active: { keyId: 'new', key: newKey },
      retained: [
        { keyId: 'new', key: newKey },
        { keyId: 'old', key: oldKey },
      ],
    }));

    const ticket = oldService.issue(validInput);

    expect(rotatedService.verify(ticket, issuedAt).signingKeyId).toBe('old');
  });

  it('rejects a pre-rotation ticket after its signing key leaves retention', () => {
    const oldKey = Buffer.from('22'.repeat(32), 'hex');
    const newKey = Buffer.from('33'.repeat(32), 'hex');
    const oldService = createTerminalLogoutTicketService(() => ({
      active: { keyId: 'old', key: oldKey },
      retained: [{ keyId: 'old', key: oldKey }],
    }));
    const afterRetention = createTerminalLogoutTicketService(() => ({
      active: { keyId: 'new', key: newKey },
      retained: [{ keyId: 'new', key: newKey }],
    }));

    const ticket = oldService.issue(validInput);

    expect(() => afterRetention.verify(ticket, issuedAt)).toThrow(
      TerminalLogoutTicketInvalidError,
    );
  });

  it('rejects a ticket when multiple retained key entries authenticate it', () => {
    const ambiguousService = createTerminalLogoutTicketService(() => ({
      active: { keyId: 'active', key: signingKey },
      retained: [
        { keyId: 'first', key: signingKey },
        { keyId: 'second', key: Buffer.from(signingKey) },
      ],
    }));
    const ticket = service.issue(validInput);

    expect(() => ambiguousService.verify(ticket, issuedAt)).toThrow(
      TerminalLogoutTicketInvalidError,
    );
  });

  it('never includes the raw ticket in errors or logs', () => {
    const ticket = `${service.issue(validInput)}.attacker-controlled`;
    let error: unknown;
    try {
      service.verify(ticket, issuedAt);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TerminalLogoutTicketInvalidError);
    expect(String(error)).not.toContain(ticket);
    expect(JSON.stringify(error)).not.toContain(ticket);
  });
});
