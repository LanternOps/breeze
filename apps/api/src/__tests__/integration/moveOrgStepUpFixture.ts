/**
 * Integration fixture: a REAL `device_move_org` step-up grant for a test that
 * drives `POST /devices/:id/move-org` end to end (spec 2026-09-18 W01).
 *
 * The route now requires, while ENABLE_2FA is on (the default), a single-use
 * grant bound to { user, session sid, live auth/mfa epochs, deviceId, orgId,
 * siteId, acceptCurrencyMismatch }. Suites that exercise the move's DATA
 * behaviour (cascades, tombstones, currency guard …) are not testing the gate,
 * so they obtain a grant the way the console will — minted through the real
 * grant store for exactly the request they are about to send — rather than
 * mocking the gate away. The gate itself is proved in
 * deviceMoveOrgStepUp.integration.test.ts.
 *
 * Deliberately derives user + sid FROM THE TOKEN the request will carry, and
 * the epochs from the live `users` row, so a grant can never be minted for a
 * binding the route would not compute.
 */
import { eq } from 'drizzle-orm';

import { users } from '../../db/schema';
import { verifyToken } from '../../services/jwt';
import { mintStepUpGrant, moveOrgResourceDigest } from '../../services/mfaStepUpGrant';
import { getTestDb } from './setup';

export interface MoveOrgBody {
  orgId: string;
  siteId: string;
  acceptCurrencyMismatch?: boolean;
  [extra: string]: unknown;
}

/** Mint a grant for `body` as sent by the holder of `token` against `deviceId`. */
export async function mintMoveOrgStepUpGrant(token: string, deviceId: string, body: MoveOrgBody): Promise<string> {
  const payload = await verifyToken(token);
  if (!payload?.sid) throw new Error('mintMoveOrgStepUpGrant: token has no sid — the route cannot bind a grant to it');
  const [actor] = await getTestDb()
    .select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);
  if (!actor) throw new Error(`mintMoveOrgStepUpGrant: user ${payload.sub} not found`);
  const grant = await mintStepUpGrant({
    userId: payload.sub,
    operation: 'device_move_org',
    authEpoch: actor.authEpoch,
    mfaEpoch: actor.mfaEpoch,
    sid: payload.sid,
    resourceDigest: moveOrgResourceDigest({
      deviceId,
      targetOrgId: body.orgId,
      targetSiteId: body.siteId,
      acceptCurrencyMismatch: body.acceptCurrencyMismatch,
    }),
  });
  if (!grant) throw new Error('mintMoveOrgStepUpGrant: grant mint failed (is Redis up?)');
  return grant;
}

/** `body` plus a freshly minted `stepUpGrant` for exactly that body. */
export async function withMoveOrgStepUpGrant<T extends MoveOrgBody>(
  token: string,
  deviceId: string,
  body: T,
): Promise<T & { stepUpGrant: string }> {
  return { ...body, stepUpGrant: await mintMoveOrgStepUpGrant(token, deviceId, body) };
}
