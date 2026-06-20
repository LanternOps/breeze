import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { randomInt } from 'crypto';
import { getRedis } from './redis';

export function generateMFASecret(): string {
  return generateSecret({ length: 20 });
}

export async function verifyMFAToken(secret: string, token: string): Promise<boolean> {
  try {
    const result = await verify({
      secret,
      token,
      epochTolerance: 30 // Allow ~30 seconds tolerance for clock drift
    });
    return result.valid;
  } catch {
    return false;
  }
}

// A used time-step record must outlive the real-time window in which any code
// for that step is still acceptable. With period=30s and ±1 step of tolerance,
// a code is valid for roughly 90s; 120s is a comfortable upper bound.
const MFA_USED_STEP_TTL_SECONDS = 120;

// Atomic "accept only if this step is strictly newer than the last consumed
// step" — single round-trip so concurrent verifies can't both win. Returns 1
// when accepted (and records the step), 0 on replay of an already-used step.
const MFA_USED_STEP_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur and tonumber(ARGV[1]) <= tonumber(cur) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

/**
 * Verify a TOTP code AND enforce single-use per (user, time-step). RFC 6238
 * §5.2 requires rejecting a previously-accepted OTP within its validity window;
 * otherwise a sniffed live code can be replayed — most impactful on the L4
 * step-up re-auth path (`requireFreshMfaStepUp`), which has no other single-use
 * binding. Returns false for an invalid code OR a replay of an already-consumed
 * step.
 *
 * Fails CLOSED on Redis unavailability: without recording the step we cannot
 * guarantee single-use, so we reject — consistent with the token-revocation /
 * login posture (which already requires Redis), so this adds no new outage
 * surface. The per-user 5/5min limiter still bounds attempts.
 */
export async function consumeMFAToken(secret: string, token: string, userId: string): Promise<boolean> {
  let result: Awaited<ReturnType<typeof verify>>;
  try {
    result = await verify({ secret, token, epochTolerance: 30 });
  } catch {
    return false;
  }
  // otplib's verify result carries the matched `timeStep` at runtime, but its
  // TS types omit it — read it through a narrow cast.
  const timeStep = (result as { timeStep?: unknown }).timeStep;
  if (!result.valid || typeof timeStep !== 'number') {
    return false;
  }

  const redis = getRedis();
  if (!redis) {
    console.error('[mfa] Redis unavailable — cannot enforce TOTP single-use; rejecting code');
    return false;
  }

  try {
    const accepted = await redis.eval(
      MFA_USED_STEP_LUA,
      1,
      `mfa:usedstep:${userId}`,
      String(timeStep),
      String(MFA_USED_STEP_TTL_SECONDS)
    );
    return accepted === 1;
  } catch (err) {
    console.error('[mfa] TOTP single-use check failed — rejecting code:', err);
    return false;
  }
}

export function generateOTPAuthURL(secret: string, email: string): string {
  return generateURI({
    secret,
    issuer: 'Breeze RMM',
    label: email,
    algorithm: 'sha1',
    digits: 6,
    period: 30
  });
}

export async function generateQRCode(otpAuthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpAuthUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 256
  });
}

export function generateRecoveryCodes(count: number = 10): string[] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = Array.from(
      { length: 8 },
      () => alphabet[randomInt(alphabet.length)]
    ).join('');
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}
