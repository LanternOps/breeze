import { eq } from 'drizzle-orm';
import { db } from '../db';
import { mobileDevices } from '../db/schema';

/**
 * Which `mobile_devices.device_id` a push registration should land on.
 *
 * Historically `/mobile/notifications/register` keyed every row on
 * `push-<platform>-<sha256(userId:platform:token)[0:48]>` — an id derived
 * entirely server-side from the push token. The phone, meanwhile, sends a
 * per-install UUID on EVERY request as `X-Breeze-Mobile-Device-Id`, and that
 * value (via the signed `mdid` claim) is what `mobileDeviceBlockedMiddleware`
 * looks up. The two id spaces never intersected, so "block this phone" matched
 * nothing and the lockout was inert in production (#2913).
 *
 * The installation id is now the device identity. The push-derived id survives
 * only as the fallback for callers that send no header, and as the key we
 * ADOPT from so already-registered phones are not orphaned into a second row.
 */
export type MobileDeviceIdPlan = {
  /** The `device_id` this caller's row should end up keyed on. */
  deviceId: string;
  /**
   * Existing row (uuid PK) whose `device_id` should be rewritten to
   * {@link deviceId} instead of inserting a fresh row. This is the anti-orphan
   * adoption path: rewriting in place keeps the uuid PK, so notification
   * preferences and every FK that points at it (`push_notifications`,
   * `mobile_sessions`, `authenticator_devices.mobile_device_id`) survive.
   */
  adoptRowId: string | null;
  /**
   * Existing ACTIVE row belonging to a DIFFERENT user that currently occupies
   * {@link deviceId} and must be salted aside before we can key on it. Only
   * possible now that the id is per-install rather than per-(user, token):
   * a second account signing in on the same phone presents the same
   * installation id.
   */
  displaceRowId: string | null;
  /**
   * Set when we declined to key on the installation id and fell back to the
   * legacy push-derived id. The caller's block control stays inert until the
   * conflict clears, so the reason is reported rather than swallowed.
   */
  fallbackReason: 'foreign-blocked-row' | 'unverified-installation-claim' | null;
};

type IncumbentRow = {
  id: string;
  userId: string;
  status: 'active' | 'blocked';
  fcmToken: string | null;
  apnsToken: string | null;
};

/** `device_id` is `varchar(255)`; salting must not overflow it. */
const MAX_DEVICE_ID_LEN = 255;

/**
 * Append a uniquifying suffix, truncating the base so the result still fits
 * `varchar(255)`. Used both to park a blocked row's replacement and to move an
 * incumbent row aside.
 */
export function saltDeviceId(base: string, at: number = Date.now()): string {
  const suffix = `-${at}`;
  const room = MAX_DEVICE_ID_LEN - suffix.length;
  return `${base.slice(0, Math.max(0, room))}${suffix}`;
}

async function loadIncumbent(deviceId: string): Promise<IncumbentRow | null> {
  const [row] = await db
    .select({
      id: mobileDevices.id,
      userId: mobileDevices.userId,
      status: mobileDevices.status,
      fcmToken: mobileDevices.fcmToken,
      apnsToken: mobileDevices.apnsToken
    })
    .from(mobileDevices)
    .where(eq(mobileDevices.deviceId, deviceId))
    .limit(1);
  return (row as IncumbentRow | undefined) ?? null;
}

/**
 * Proof that the caller is physically on the install that owns `incumbent`.
 *
 * The installation id travels in a client-controlled header, so on its own it
 * is a claim, not evidence — anyone who learns another user's id could assert
 * it and push that user's row aside. The APNs/FCM token, by contrast, is
 * minted by the OS per app INSTALL (not per account): a colleague genuinely
 * signing in on the same handset submits the same token the incumbent row
 * already holds, while a forger elsewhere cannot.
 */
function tokenProvesSameInstall(
  incumbent: IncumbentRow,
  platform: 'ios' | 'android',
  token: string
): boolean {
  const held = platform === 'ios' ? incumbent.apnsToken : incumbent.fcmToken;
  return held !== null && held.length > 0 && held === token;
}

/**
 * A row we own that is already blocked must never be reactivated by a
 * re-registration, so the fresh row takes a salted id (pre-existing behaviour,
 * kept as defence-in-depth — `mobileDeviceBlockedMiddleware` is mounted in
 * front of `/mobile/*`, so a blocked phone cannot actually reach this route).
 */
function keyForOwnRow(incumbent: IncumbentRow | null, deviceId: string): string {
  return incumbent?.status === 'blocked' ? saltDeviceId(deviceId) : deviceId;
}

/**
 * Decide which `device_id` a push registration writes, and whether it should
 * adopt or displace an existing row. Pure reads — the caller performs the
 * writes so they stay in the route's audit/response flow.
 */
export async function planMobileDeviceId(params: {
  userId: string;
  /** Normalised `X-Breeze-Mobile-Device-Id`, or null when absent. */
  installationId: string | null;
  /** `push-<platform>-<hash>`, the pre-#2913 key. */
  legacyDeviceId: string;
  platform: 'ios' | 'android';
  /** The push token being registered — doubles as proof of install possession. */
  token: string;
}): Promise<MobileDeviceIdPlan> {
  const { userId, installationId, legacyDeviceId, platform, token } = params;

  const fallbackToLegacy = async (
    reason: MobileDeviceIdPlan['fallbackReason']
  ): Promise<MobileDeviceIdPlan> => {
    const legacyRow = await loadIncumbent(legacyDeviceId);
    return {
      deviceId: keyForOwnRow(legacyRow, legacyDeviceId),
      adoptRowId: null,
      displaceRowId: null,
      fallbackReason: reason
    };
  };

  // No header: a legacy client or a non-mobile caller. Keep the original
  // push-derived keying verbatim — the block check cannot see these rows
  // either way, and changing their key would strand them.
  if (!installationId) {
    return fallbackToLegacy(null);
  }

  const incumbent = await loadIncumbent(installationId);

  if (!incumbent) {
    // First registration under the installation id. If this phone already has
    // a push-derived row, move that row onto the new key rather than leaving
    // it behind as a duplicate entry in the user's device list.
    const legacyRow = await loadIncumbent(legacyDeviceId);
    if (legacyRow && legacyRow.userId === userId && legacyRow.status === 'active') {
      return {
        deviceId: installationId,
        adoptRowId: legacyRow.id,
        displaceRowId: null,
        fallbackReason: null
      };
    }
    return { deviceId: installationId, adoptRowId: null, displaceRowId: null, fallbackReason: null };
  }

  if (incumbent.userId === userId) {
    return {
      deviceId: keyForOwnRow(incumbent, installationId),
      adoptRowId: null,
      displaceRowId: null,
      fallbackReason: null
    };
  }

  // The installation id belongs to another account.
  if (incumbent.status === 'blocked') {
    // Never disturb someone else's revocation — moving it aside would let any
    // account holder clear another user's lost-phone block just by signing in
    // on the device. Fall back to push-derived keying so this caller still
    // receives notifications; their own block control stays inert until the
    // other user's row is gone, which is the safe direction to fail.
    return fallbackToLegacy('foreign-blocked-row');
  }

  if (!tokenProvesSameInstall(incumbent, platform, token)) {
    // Someone asserted another user's installation id without holding that
    // install's push token. Treat it as unproven and leave the foreign row
    // untouched rather than letting a forged header evict it.
    return fallbackToLegacy('unverified-installation-claim');
  }

  // Same handset, different account: the previous user signed out and a
  // colleague signed in. Park the incumbent under a salted id — never reuse its
  // row, which would hand the new user the previous user's quiet hours,
  // severity filters and notification history.
  return {
    deviceId: installationId,
    adoptRowId: null,
    displaceRowId: incumbent.id,
    fallbackReason: null
  };
}
