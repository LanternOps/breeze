import type { TokenPayload } from './jwt';
import { PG_UUID_REGEX } from '../utils/uuid';

/**
 * The sign-in session (refresh-family id, the access token's `sid`) behind an
 * authenticated request, or null when the request has none (API key, agent
 * principal, legacy token). Remote sessions record it so that logging out of
 * that sign-in also ends them (services/remoteWsAuthorization.ts).
 */
export function authSignInSessionId(auth: { token?: Pick<TokenPayload, 'sid'> | null }): string | null {
  const sid = auth.token?.sid;
  return sid && PG_UUID_REGEX.test(sid) ? sid : null;
}
