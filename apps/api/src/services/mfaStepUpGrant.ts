import { randomUUID } from 'crypto';
import { getRedis } from './redis';

/**
 * SR2-20: existing-factor step-up grant for adding a NEW MFA factor to an
 * ALREADY-PROTECTED account, OR registering an authenticator device as an
 * approver. Minted by `POST /auth/mfa/step-up` after the caller proves an
 * existing factor (TOTP/SMS/passkey), then presented back to a factor-addition
 * endpoint (`/mfa/enable`, setup-confirm, `/mfa/sms/enable`, `/passkeys/register/*`)
 * as `stepUpGrantId`, or to an authenticator registration route
 * (`POST /authenticator/register/options`, `/authenticator/register/verify`).
 *
 * Bound to the live `authEpoch`/`mfaEpoch` + the initiating session's `sid` so
 * a factor change (which bumps `mfa_epoch` + revokes refresh families) or a
 * session switch invalidates any outstanding grant. Single-use via Redis
 * `getdel` at the terminal write; non-consuming `validateStepUpGrant` exists
 * for the intermediate `register/options` step (the SAME grant is consumed
 * later at `/register/verify`).
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

/** Mint a short-lived single-use step-up grant. Returns null if Redis is down (caller fails closed). */
export async function mintStepUpGrant(bind: GrantBind): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  const id = randomUUID();
  await redis.setex(key(id), TTL_SECONDS, JSON.stringify(bind));
  return id;
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
