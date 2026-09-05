import { SignJWT, importPKCS8 } from 'jose';
import { captureException } from '../sentry';

/**
 * Play Integrity verdict verification (#1374, feature #4707 wave W04).
 *
 * WHAT THIS IS AND IS NOT (plan decision 3): Play Integrity attests the APP and
 * the DEVICE POSTURE — that the binary is the one Google Play distributed and
 * that the device passes Google's integrity checks. It says nothing about where
 * a given private key lives. Android **Key Attestation** is what proves that,
 * and it alone sets `platform_bound_basis`. A verdict from here only ever sets
 * `app_integrity_verified_at`.
 *
 * Consequently this module is OPTIONAL on two axes:
 *  - the CLIENT may omit the token (enterprise / non-Play distribution), and
 *  - the SERVER may have no `PLAY_INTEGRITY_SERVICE_ACCOUNT`, in which case
 *    every call returns null and registration proceeds on Key Attestation
 *    alone. An unconfigured deploy degrades, it does not refuse registrations.
 *
 * But a token that IS presented and CAN be read must be good. A verdict saying
 * the app is unrecognised or the device fails integrity is the client telling
 * us it is compromised; that throws and the registration fails. The split is:
 *   - a bad VERDICT           → throw (the client's claim is disqualifying)
 *   - our own INFRASTRUCTURE  → null + Sentry (a Google outage must not lock a
 *     failing to reach Google    technician out of registering an approver key
 *                                whose trust comes from Key Attestation)
 */

/** Verdicts that satisfy "this binary is the one Google Play distributed". */
const ACCEPTED_APP_RECOGNITION_VERDICTS = new Set(['PLAY_RECOGNIZED']);

/** The device-integrity label the approval path requires. */
const REQUIRED_DEVICE_VERDICT = 'MEETS_DEVICE_INTEGRITY';

/**
 * How stale a verdict may be. Matched to the registration attempt TTL
 * (`ATTEMPT_TTL_SECONDS` in authenticatorAttestation.ts): the token is minted
 * inside the same attempt window, so anything older is not from this attempt.
 */
const MAX_VERDICT_AGE_MS = 300_000;

/** Tolerance for the device clock running ahead of ours. */
const MAX_CLOCK_SKEW_MS = 60_000;

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const PLAY_INTEGRITY_API = 'https://playintegrity.googleapis.com/v1';

export interface PlayIntegrityServiceAccount {
  clientEmail: string;
  privateKey: string;
}

/** The subset of Play Integrity's `TokenPayloadExternal` this module reads. */
export interface PlayIntegrityTokenPayload {
  requestDetails?: {
    requestPackageName?: string;
    requestHash?: string;
    timestampMillis?: string;
  };
  appIntegrity?: {
    appRecognitionVerdict?: string;
    packageName?: string;
  };
  deviceIntegrity?: {
    deviceRecognitionVerdict?: string[];
  };
}

export interface PlayIntegrityVerdict {
  appRecognitionVerdict: string;
  deviceRecognitionVerdicts: string[];
  packageName: string;
}

export type PlayIntegrityDecoder = (args: {
  token: string;
  packageName: string;
  serviceAccount: PlayIntegrityServiceAccount;
}) => Promise<PlayIntegrityTokenPayload>;

export interface VerifyPlayIntegrityOptions {
  packageName: string;
  /**
   * base64url of the registration transcript. REQUIRED, not optional: without
   * it a verdict minted for any other session of the same app on the same
   * device replays inside the freshness window. W06's Kotlin must pass this
   * digest to `StandardIntegrityTokenRequest.setRequestHash(...)`.
   */
  expectedRequestHash: string;
  now?: Date;
  /** Seam for tests; production uses the Google-managed decode endpoint. */
  decodeIntegrityToken?: PlayIntegrityDecoder;
}

export class PlayIntegrityVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlayIntegrityVerdictError';
  }
}

const reject = (message: string): never => {
  throw new PlayIntegrityVerdictError(message);
};

// ---------------------------------------------------------------------------
// Configuration — mirrors FIREBASE_SERVICE_ACCOUNT (services/fcm.ts)
// ---------------------------------------------------------------------------

/**
 * Accept the service-account JSON raw or base64-encoded, and repair the two
 * ways a PEM gets mangled on the way into an env var: `private_key` in Google's
 * snake_case, and literal `\n` two-character sequences instead of newlines.
 *
 * Returns null (never throws) on anything unusable — the caller's contract is
 * "unconfigured degrades", and a mangled value is indistinguishable from an
 * absent one from the registration path's point of view. `validate.ts` is what
 * turns a mangled value into a loud boot failure.
 */
export function parsePlayIntegrityServiceAccount(
  raw: string | undefined,
): PlayIntegrityServiceAccount | null {
  if (!raw) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const clientEmail = (parsed.clientEmail ?? parsed.client_email) as string | undefined;
  const rawKey = (parsed.privateKey ?? parsed.private_key) as string | undefined;
  if (typeof clientEmail !== 'string' || typeof rawKey !== 'string') return null;

  return { clientEmail, privateKey: rawKey.replace(/\\n/g, '\n') };
}

let cachedServiceAccount: PlayIntegrityServiceAccount | null = null;
let cachedServiceAccountRaw: string | undefined;

function serviceAccount(): PlayIntegrityServiceAccount | null {
  const raw = process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT;
  // Re-parse when the env var changes rather than caching the first read
  // forever: the singleton is a parse cache, not a config freeze.
  if (raw !== cachedServiceAccountRaw) {
    cachedServiceAccountRaw = raw;
    cachedServiceAccount = parsePlayIntegrityServiceAccount(raw);
  }
  return cachedServiceAccount;
}

/** True iff a usable PLAY_INTEGRITY_SERVICE_ACCOUNT is present. */
export function isPlayIntegrityConfigured(): boolean {
  return serviceAccount() !== null;
}

/** Test seam: drop the parsed service account and the cached access token. */
export function __resetPlayIntegrityForTests(): void {
  cachedServiceAccount = null;
  cachedServiceAccountRaw = undefined;
  cachedAccessToken = null;
}

// ---------------------------------------------------------------------------
// Google-managed token decoding
// ---------------------------------------------------------------------------

let cachedAccessToken: { token: string; expiresAtMs: number } | null = null;

/**
 * Mint (and briefly cache) an OAuth2 access token from the service account, via
 * the JWT-bearer grant: sign an assertion with the account's private key and
 * exchange it. `jose` does the RS256 signing.
 */
async function accessToken(account: PlayIntegrityServiceAccount): Promise<string> {
  const nowMs = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAtMs > nowMs + 30_000) {
    return cachedAccessToken.token;
  }

  const key = await importPKCS8(account.privateKey, 'RS256');
  const assertion = await new SignJWT({ scope: PLAY_INTEGRITY_SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(account.clientEmail)
    .setSubject(account.clientEmail)
    .setAudience(OAUTH_TOKEN_URL)
    .setIssuedAt(Math.floor(nowMs / 1000))
    .setExpirationTime(Math.floor(nowMs / 1000) + 3600)
    .sign(key);

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Play Integrity token exchange failed with HTTP ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error('Play Integrity token exchange returned no access_token');

  cachedAccessToken = {
    token: body.access_token,
    expiresAtMs: nowMs + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}

/**
 * Google-managed decryption: hand the opaque token to
 * `playintegrity.googleapis.com:decodeIntegrityToken` and get the verdict back.
 *
 * Deliberately NOT the local-decryption path, which needs an AES/EC key pair
 * downloaded from Play Console (a different secret from a service account) and
 * which Google recommends against for exactly the key-management reason.
 */
const googleManagedDecoder: PlayIntegrityDecoder = async ({
  token,
  packageName,
  serviceAccount: account,
}) => {
  const bearer = await accessToken(account);
  const res = await fetch(
    `${PLAY_INTEGRITY_API}/${encodeURIComponent(packageName)}:decodeIntegrityToken`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ integrity_token: token }),
    },
  );
  if (!res.ok) {
    throw new Error(`Play Integrity decodeIntegrityToken returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { tokenPayloadExternal?: PlayIntegrityTokenPayload };
  if (!body.tokenPayloadExternal) {
    throw new Error('Play Integrity decodeIntegrityToken returned no tokenPayloadExternal');
  }
  return body.tokenPayloadExternal;
};

// ---------------------------------------------------------------------------
// Verdict evaluation
// ---------------------------------------------------------------------------

function assertVerdict(
  payload: PlayIntegrityTokenPayload,
  opts: VerifyPlayIntegrityOptions,
  now: Date,
): PlayIntegrityVerdict {
  const requestPackageName = payload.requestDetails?.requestPackageName;
  if (requestPackageName !== opts.packageName) {
    reject(
      `Play Integrity verdict is for package ${requestPackageName ?? '(absent)'}, not ${opts.packageName}`,
    );
  }
  const appPackageName = payload.appIntegrity?.packageName;
  // Both fields name the package; a disagreement means the verdict was
  // assembled from two different requests.
  if (appPackageName !== undefined && appPackageName !== opts.packageName) {
    reject(
      `Play Integrity appIntegrity package ${appPackageName} disagrees with requestDetails ${opts.packageName}`,
    );
  }

  // Bind the verdict to THIS registration attempt. Without it a verdict from
  // any other session of the app on the same device replays inside the window.
  const requestHash = payload.requestDetails?.requestHash;
  if (!requestHash) {
    reject(
      'Play Integrity verdict carries no request hash — the client must bind the token to the registration transcript',
    );
  }
  if (requestHash !== opts.expectedRequestHash) {
    reject('Play Integrity request hash does not equal the registration transcript');
  }

  const timestampMillis = Number(payload.requestDetails?.timestampMillis);
  if (!Number.isFinite(timestampMillis)) {
    reject('Play Integrity verdict carries no usable timestampMillis');
  }
  const ageMs = now.getTime() - timestampMillis;
  if (ageMs > MAX_VERDICT_AGE_MS) {
    reject(`Play Integrity verdict is stale (${Math.round(ageMs / 1000)}s old)`);
  }
  if (ageMs < -MAX_CLOCK_SKEW_MS) {
    reject('Play Integrity verdict timestamp is in the future beyond the allowed clock skew');
  }

  const appRecognitionVerdict = payload.appIntegrity?.appRecognitionVerdict;
  if (!appRecognitionVerdict || !ACCEPTED_APP_RECOGNITION_VERDICTS.has(appRecognitionVerdict)) {
    reject(
      `Play Integrity app recognition verdict is ${appRecognitionVerdict ?? '(absent)'}, not PLAY_RECOGNIZED`,
    );
  }

  const deviceRecognitionVerdicts = payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
  if (!deviceRecognitionVerdicts.includes(REQUIRED_DEVICE_VERDICT)) {
    reject(
      `Play Integrity device integrity verdict [${deviceRecognitionVerdicts.join(', ') || 'empty'}] does not include ${REQUIRED_DEVICE_VERDICT}`,
    );
  }

  return {
    appRecognitionVerdict: appRecognitionVerdict!,
    deviceRecognitionVerdicts,
    packageName: opts.packageName,
  };
}

/**
 * Decode and evaluate a Play Integrity token.
 *
 * Returns null when Play Integrity is not configured, or when we could not
 * reach Google — both are OUR gaps, and neither is evidence against the client.
 * Throws `PlayIntegrityVerdictError` when the verdict itself is disqualifying.
 */
export async function verifyPlayIntegrityToken(
  token: string,
  opts: VerifyPlayIntegrityOptions,
): Promise<PlayIntegrityVerdict | null> {
  const account = serviceAccount();
  if (!account) return null;

  const decode = opts.decodeIntegrityToken ?? googleManagedDecoder;
  let payload: PlayIntegrityTokenPayload;
  try {
    payload = await decode({ token, packageName: opts.packageName, serviceAccount: account });
  } catch (err) {
    // Infrastructure, not a bad client. Loud in Sentry, invisible to the
    // technician, and the registration continues on Key Attestation alone.
    captureException(err, undefined, {
      area: 'play_integrity',
      reason: 'decode_unavailable',
    });
    console.error('[play-integrity] could not decode integrity token', {
      packageName: opts.packageName,
      error: (err as Error).message,
    });
    return null;
  }

  return assertVerdict(payload, opts, opts.now ?? new Date());
}
