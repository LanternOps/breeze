import { describe, it, expect } from 'vitest';
import { isInteractiveUserSession, type AuthContext, type PrincipalKind } from './auth';

/**
 * Contract tests for the principal-kind discriminator.
 *
 * The field exists because `user.id` cannot answer "is a human doing this?":
 * an MCP API key is built with `user.id = apiKey.createdBy`, so a key and the
 * person who minted it are identical by identity alone. These tests pin the
 * semantics that gates will rely on; the per-builder assertions (which builder
 * emits which kind) live beside each builder's own suite.
 */

function authWith(principal: PrincipalKind): Pick<AuthContext, 'principal'> {
  return { principal };
}

describe('isInteractiveUserSession', () => {
  it('accepts only user_session', () => {
    expect(isInteractiveUserSession(authWith({ kind: 'user_session' }))).toBe(true);
  });

  it.each<PrincipalKind>([
    { kind: 'client_user' },
    { kind: 'api_key', apiKeyId: 'key-1' },
    { kind: 'oauth_grant', grantId: 'grant-1' },
    { kind: 'agent', deviceId: 'device-1' },
    { kind: 'helper', deviceId: 'device-1' },
    { kind: 'system', reason: 'test' },
  ])('rejects $kind', (principal) => {
    expect(isInteractiveUserSession(authWith(principal))).toBe(false);
  });

  it('rejects an api_key even when it carries a real human user id', () => {
    // The exact confusion the discriminator exists to prevent: this context's
    // `user.id` IS a person (the key's creator), and every identity-based
    // check would pass. Only the principal kind distinguishes it.
    const humanWhoMintedTheKey = 'user-abc';
    const keyAuth = {
      principal: { kind: 'api_key', apiKeyId: 'key-1' } as PrincipalKind,
      user: { id: humanWhoMintedTheKey },
    };
    const sessionAuth = {
      principal: { kind: 'user_session' } as PrincipalKind,
      user: { id: humanWhoMintedTheKey },
    };

    expect(keyAuth.user.id).toBe(sessionAuth.user.id);
    expect(isInteractiveUserSession(keyAuth)).toBe(false);
    expect(isInteractiveUserSession(sessionAuth)).toBe(true);
  });

  it('rejects client_user, which is interactive but not a Breeze operator', () => {
    // A customer's employee in the Excel add-in is a real human in a real
    // session. Gates that mean "an MSP tech" must not accept them, so
    // client_user is deliberately a separate kind rather than user_session.
    expect(isInteractiveUserSession(authWith({ kind: 'client_user' }))).toBe(false);
  });
});
