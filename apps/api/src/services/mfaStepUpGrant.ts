import { createHash, randomUUID } from 'crypto';
import { getRedis } from './redis';

/**
 * SR2-20 / #2707: existing-factor step-up grant for adding a NEW MFA factor to
 * an ALREADY-PROTECTED account, OR registering an authenticator device as an
 * approver.
 *
 * Minted by FOUR sources: (1) `POST /auth/mfa/step-up`, after the caller
 * proves an existing factor (TOTP/SMS/passkey); (2)
 * `POST /authenticator/register-grant`, the password-proof fallback for
 * accounts with no stronger factor; (3) `mintLoginRegisterGrant`
 * (`routes/auth/helpers.ts`), a best-effort login-time mint for mobile
 * clients only; (4) the SSO re-auth callback (`GET /sso/callback`, reauth
 * mode), the passwordless equivalent of (2) — see #4018.
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
export type StepUpOperation =
  | 'add_factor'
  | 'register_approver_device'
  | 'agent_rollback'
  | 'enroll_first_factor'
  // RMM-QA-176: entering or EXTENDING device maintenance mode. Bound by
  // resourceDigest to the exact { deviceIds, reason, durationHours } the
  // technician was shown, so a grant can never be replayed against a
  // different device set or a longer window.
  | 'device_maintenance';

export interface StepUpGrant {
  id: string;
  userId: string;
  operation: StepUpOperation;
  authEpoch: number;
  mfaEpoch: number;
  sid: string;
  resourceDigest: string;
}

export type StepUpGrantBinding = Omit<StepUpGrant, 'id'>;
type GrantBind = Omit<StepUpGrantBinding, 'resourceDigest'> & { resourceDigest?: string };

const TTL_SECONDS = 300;
const key = (id: string) => `mfa:stepup:${id}`;

function bindsMatch(record: GrantBind, bind: GrantBind): boolean {
  return record.userId === bind.userId
    && record.operation === bind.operation
    && record.authEpoch === bind.authEpoch
    && record.mfaEpoch === bind.mfaEpoch
    && record.sid === bind.sid
    && (record.resourceDigest ?? '') === (bind.resourceDigest ?? '');
}

export function rollbackResourceDigest(input: {
  deviceId: string;
  currentVersion: string;
  targetVersion: string;
  reason: string;
}): `sha256:${string}` {
  const canonical = JSON.stringify({
    currentVersion: input.currentVersion,
    deviceId: input.deviceId,
    reason: input.reason,
    targetVersion: input.targetVersion,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

// The device-maintenance maxima moved to services/maintenanceStepUpLimits.ts —
// see that file's header for why a constant must not live in a module this
// many suites mock wholesale.

/**
 * Canonical digest for a device-maintenance grant.
 *
 * Canonicalization is part of the security contract, not a convenience: the
 * mint route and the maintenance routes must produce byte-identical input for
 * the same operator intent, so `deviceIds` is deduplicated and sorted and
 * `reason` is trimmed here — in ONE function both callers use — rather than at
 * each call site. Keys are emitted in a fixed alphabetical order because
 * JSON.stringify preserves insertion order, which would otherwise let two
 * equivalent objects hash differently.
 */
export function maintenanceResourceDigest(input: {
  deviceIds: string[];
  reason: string;
  durationHours: number;
}): `sha256:${string}` {
  const canonical = JSON.stringify({
    deviceIds: [...new Set(input.deviceIds)].sort(),
    durationHours: input.durationHours,
    reason: input.reason.trim(),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
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
  if (!redis) {
    console.error(`[mfaStepUpGrant] mint declined for user ${bind.userId} (${bind.operation}): Redis unavailable`);
    return null;
  }
  try {
    const id = randomUUID();
    const normalized: StepUpGrantBinding = { ...bind, resourceDigest: bind.resourceDigest ?? '' };
    await redis.setex(key(id), TTL_SECONDS, JSON.stringify(normalized));
    return id;
  } catch (err) {
    // Still fails closed (null), but no longer silently: a bare `catch {}` here
    // made a Redis outage indistinguishable from a user abandoning the flow —
    // the caller redirects with an opaque code and the cause never reaches a
    // log. Callers add their own audit row; this is the technical cause.
    console.error(`[mfaStepUpGrant] mint failed for user ${bind.userId} (${bind.operation}):`, err);
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
