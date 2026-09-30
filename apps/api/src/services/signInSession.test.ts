import { describe, expect, it } from 'vitest';
import { authSignInSessionId } from './signInSession';

describe('authSignInSessionId', () => {
  it('returns the access token sid (the sign-in refresh family)', () => {
    expect(authSignInSessionId({ token: { sid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }))
      .toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it.each([
    ['no token (API key / agent principal)', { token: null }],
    ['a token without sid', { token: {} }],
    ['a sid that cannot name a family', { token: { sid: 'test-session-id' } }],
  ])('returns null for %s', (_label, auth) => {
    expect(authSignInSessionId(auth)).toBeNull();
  });
});
