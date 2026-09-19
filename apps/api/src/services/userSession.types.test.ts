import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { installAuthorizedUserSessionCookies } from '../routes/auth/helpers';
import type { AuthorizedUserSession } from './userSession';

declare const context: Context;
declare const guarded: AuthorizedUserSession;

if (false) {
  installAuthorizedUserSessionCookies(context, guarded);

  // @ts-expect-error A structural token pair cannot cross the guarded boundary.
  installAuthorizedUserSessionCookies(context, { refreshToken: 'structural' });
}

describe('user-session cookie boundary types', () => {
  it('keeps compile-only brand assertions in the API typecheck', () => {
    expect(true).toBe(true);
  });
});
