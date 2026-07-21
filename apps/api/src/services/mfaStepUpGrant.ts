import { randomUUID } from 'crypto';
import { getRedis } from './redis';

/**
 * SR2-20 / #2707: existing-factor step-up grant for adding a NEW MFA factor to
 * an ALREADY-PROTECTED account, OR registering an authenticator device as an
 * approver.
 *
 * Minted by THREE sources: (1) `POST /auth/mfa/step-up`, after the caller
 * proves an existing factor (TOTP/SMS/passkey); (2)
 * `POST /authenticator/register-grant`, the password-proof fallback for
 * accounts with no stronger factor; (3) `mintLoginRegisterGrant`
 * (`routes/auth/helpers.ts`), a best-effort login-time mint for mobile
 * clients only.
 *
 * Grants from (1) are presented back to a factor-addition endpoint
 * (`/mfa/enable`, setup-confirm, `/mfa/sms/enable`, `/passkeys/register/*`) as
 * `stepUpGrantId`. Grants for approver-device registration (from any of the
 * three sources) are presented as `registerGrantId` to
 * `POST /authenticator/devices/webauthn/options`,
 * `POST /authenticator/devices/webauthn/verify`, or the mobile
 * `POST /authenticator/devices`.
 *
 * Bound to the live `authEpoch`/`mfaEpoch` + the initiating session's `sid` so
 * a factor change (which bumps `mfa_epoch` + revokes refresh families) or a
 * session switch invalidates any outstanding grant. Single-use via Redis
 * `getdel` at the terminal write; non-consuming `validateStepUpGrant` exists
 * for the intermediate `webauthn/options` step (the SAME grant is consumed
 * later at `webauthn/verify`).
 */
/** Operations a step-up grant can authorize. A grant minted for one operation
 * can never validate/consume for another (bindsMatch checks equality). */
export type StepUpOperation = 'add_factor' | 'register_approver_device';

export interface StepUpGrant {
  id: string;
  userId: string;
  operation: StepUpOperation;
  authEpoch: number;
  mfaEpoch: number;
  sid: string;
}

type GrantBind = Omit<StepUpGrant, 'id'>;

const TTL_SECONDS = 300;
const key = (id: string) => `mfa:stepup:${id}`;

function bindsMatch(record: GrantBind, bind: GrantBind): boolean {
  return record.userId === bind.userId
    && record.operation === bind.operation
    && record.authEpoch === bind.authEpoch
    && record.mfaEpoch === bind.mfaEpoch
    && record.sid === bind.sid;
}

/**
 * Mint a short-lived single-use step-up grant. Returns null if Redis is down
 * OR the write itself rejects (fails closed) — mirrors the try/catch already
 * present on validate/consume below, so a transient Redis error here can
 * never propagate as an uncaught rejection into a caller like
 * `mintLoginRegisterGrant` that must never throw.
 */
export async function mintStepUpGrant(bind: GrantBind): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const id = randomUUID();
    await redis.setex(key(id), TTL_SECONDS, JSON.stringify(bind));
    return id;
  } catch {
    return null;
  }
}

/** Non-consuming check (register/options). Fails closed on Redis down/error/miss/mismatch. */
export async function validateStepUpGrant(id: string, bind: GrantBind): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const raw = await redis.get(key(id));
    if (!raw) return false;
    return bindsMatch(JSON.parse(raw) as GrantBind, bind);
  } catch {
    return false;
  }
}

/** Single-use consume via getdel (every terminal factor write). Fails closed. */
export async function consumeStepUpGrant(id: string, bind: GrantBind): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    const raw = await redis.getdel(key(id));
    if (!raw) return false;
    return bindsMatch(JSON.parse(raw) as GrantBind, bind);
  } catch {
    return false;
  }
}
