import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  installAuthorizedUserSessionCookies,
  installLegacyUserSessionCookiesDuringTransition,
} from '../routes/auth/helpers';
import type {
  AuthorizedUserSession,
  LegacyUserSessionDuringTransition,
} from './userSession';

declare const context: Context;
declare const guarded: AuthorizedUserSession;
declare const legacy: LegacyUserSessionDuringTransition;

if (false) {
  installAuthorizedUserSessionCookies(context, guarded);
  installLegacyUserSessionCookiesDuringTransition(context, legacy);

  // @ts-expect-error A structural token pair cannot cross the guarded boundary.
  installAuthorizedUserSessionCookies(context, { refreshToken: 'structural' });
  // @ts-expect-error A structural token pair cannot cross the rollout-only legacy boundary.
  installLegacyUserSessionCookiesDuringTransition(context, { refreshToken: 'structural' });
}

describe('user-session cookie boundary types', () => {
  it('keeps compile-only brand assertions in the API typecheck', () => {
    expect(true).toBe(true);
  });
});
