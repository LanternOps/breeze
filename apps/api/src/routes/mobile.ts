import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { scriptParametersSchema } from '@breeze/shared';
import { and, asc, desc, eq, gte, ilike, inArray, like, ne, or, sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { db } from '../db';
import {
  aiSessions,
  alerts,
  alertRules,
  alertTemplates,
  deviceCommands,
  devices,
  mobileDevices,
  sites
} from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { userRateLimit } from '../middleware/userRateLimit';
import { setCooldown, markConfigPolicyRuleCooldown } from '../services/alertCooldown';
import {
  ALERT_ACKNOWLEDGE_CAS_LOST_MESSAGE,
  ALERT_CAS_LOST_MESSAGE,
  buildAcknowledgeAlertCas,
  buildResolveAlertCas,
} from '../services/alertService';
import { writeRouteAudit } from '../services/auditEvents';
import { publishEvent } from '../services/eventBus';
import { escapeLike } from '../utils/sql';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../services/permissions';
import { dispatchWake } from '../services/wakeOnLan';
import { executeScriptOnDevices } from '../services/scriptExecution';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { emitAlertStateFeedback } from '../services/mlFeedbackEmitters';
import { readMobileDeviceId } from '../services/mobileDeviceBinding';
import { planMobileDeviceId, saltDeviceId } from '../services/mobileDeviceIdentity';
import { captureMessage } from '../services/sentry';
import { createReportThrottle } from '../utils/reportThrottle';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { UUID_REGEX } from '../utils/uuid';
import {
  assertDeviceExecuteAllowed,
  TrustDeniedError,
} from '../services/partnerTrust.commands';
import { trustDenyBody } from '../services/partnerTrust';
// Shared with the web device routes rather than re-declared locally. This file
// used to carry a byte-identical private copy, which is precisely why the #2968
// uuid guard — added to the shared helper — silently did not apply to
// POST /mobile/devices/:id/actions. One definition, one guard.
import { getDeviceWithOrgCheck } from './devices/helpers';

export const mobileRoutes = new Hono();
const requireMobileAlertRead = requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action);
const requireMobileAlertAcknowledge = requirePermission(PERMISSIONS.ALERTS_ACKNOWLEDGE.resource, PERMISSIONS.ALERTS_ACKNOWLEDGE.action);
const requireMobileAlertWrite = requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action);
const requireMobileDeviceRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
const requireMobileDeviceExecute = requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);

async function requireScriptExecuteForRunScript(c: import('hono').Context, next: import('hono').Next) {
  const data = (c.req as unknown as { valid: (target: 'json') => { action?: string } }).valid('json');
  if (data.action !== 'run_script') {
    return next();
  }
  return requirePermission(PERMISSIONS.SCRIPTS_EXECUTE.resource, PERMISSIONS.SCRIPTS_EXECUTE.action)(c, next);
}

// Helper functions
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

// Keyset cursor: opaque base64url JSON {key,id}. Optional and additive — when
// not supplied, page/limit semantics are unchanged. When supplied, paginates
// past the (key,id) pair on the route's chosen ordering column.
//
// `key` is carried as a raw, already-serialized string and never re-parsed
// into a JS `Date` here — `Date` only holds millisecond precision, so
// round-tripping a Postgres `timestamp` (microsecond precision) through one
// truncates it and can skip rows whose actual value sits between the
// truncated cursor and the next real boundary (#3770). Callers that key on a
// timestamp column are responsible for reading it back as raw text (see
// `/alerts/inbox`'s `triggeredAtKey`) rather than a parsed `Date`; callers
// that key on a NOT NULL string column (e.g. `/devices`'s `hostname`, ported
// from `routes/devices/core.ts`) just pass the string through.
// Exported for unit testing.
export type CursorTuple = { key: string; id: string };
export function encodeCursor(key: string | null | undefined, id: string | null | undefined): string | null {
  if (!key || !id) return null;
  return Buffer.from(JSON.stringify({ key, id }), 'utf8').toString('base64url');
}
export function decodeCursor(raw: string | undefined): CursorTuple | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { key?: unknown; id?: unknown };
    if (typeof parsed.key !== 'string' || parsed.key.length === 0) return null;
    if (typeof parsed.id !== 'string' || !UUID_REGEX.test(parsed.id)) return null;
    return { key: parsed.key, id: parsed.id };
  } catch {
    return null;
  }
}

// `/alerts/inbox` keys on a timestamp column, so on top of the structural
// checks above, reject a cursor whose `key` doesn't even parse as a
// timestamp — otherwise it reaches the raw SQL comparison in the route and
// Postgres 500s on the bad cast instead of a clean "start over".
export function decodeTimestampCursor(raw: string | undefined): CursorTuple | null {
  const cursor = decodeCursor(raw);
  if (!cursor) return null;
  return Number.isNaN(new Date(cursor.key).getTime()) ? null : cursor;
}

/**
 * Thrown inside the displace transaction to roll it back; mapped to a 409 by
 * the caller. Never escapes the route.
 */
class MobileDeviceRegistrationConflict extends Error {}

/**
 * Throttled per (reason, caller) rather than per reason alone. The key space
 * matters: `unverified-installation-claim` means someone asserted ANOTHER
 * account's installation id without holding that install's push token — an
 * attempted eviction of a stranger's device row. A process-wide key would
 * collapse a campaign enumerating ids across many users into a single event
 * indistinguishable from one benign occurrence.
 */
const registrationFallbackThrottle = createReportThrottle(15 * 60 * 1000);
const registrationConflictThrottle = createReportThrottle(15 * 60 * 1000);

/** Test seam: clears the registration report throttles. */
export function _resetRegistrationFallbackReportsForTests(): void {
  registrationFallbackThrottle.reset();
  registrationConflictThrottle.reset();
}

/**
 * Both 409 exits, with a signal attached. A phone whose installation id is
 * permanently held by a foreign or blocked row would otherwise 409 on every
 * app foreground and produce no server-side evidence at all — the same
 * "indistinguishable from working" failure mode #2913 is about.
 */
function registrationConflict(
  c: import('hono').Context,
  userId: string,
  reason: 'displace-insert-conflict' | 'upsert-guard-matched-no-row'
) {
  if (registrationConflictThrottle.shouldReport(`${reason}:${userId}`)) {
    captureMessage(
      'mobile push registration conflicted — the phone is not receiving notifications',
      {
        eventCode: 'mobile_push_registration_conflict',
        tags: { mobile_registration_reason: reason },
      }
    );
  }
  return c.json(
    {
      error: 'This device could not be registered for notifications.',
      code: 'device_registration_conflict'
    },
    409
  );
}

function derivePushDeviceId(userId: string, platform: 'ios' | 'android', token: string) {
  const tokenHash = createHash('sha256')
    .update(`${userId}:${platform}:${token}`)
    .digest('hex')
    .slice(0, 48);
  return `push-${platform}-${tokenHash}`;
}

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  // system scope has access to all
  return true;
}

async function getOrgIdsForAuth(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>,
  orgId?: string
) {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: { message: 'Organization context required', status: 403 } };
    }
    return { orgIds: [auth.orgId] };
  }

  if (auth.scope === 'partner') {
    if (orgId) {
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return { error: { message: 'Access to this organization denied', status: 403 } };
      }
      return { orgIds: [orgId] };
    }
    return { orgIds: auth.accessibleOrgIds ?? [] };
  }

  if (auth.scope === 'system' && orgId) {
    return { orgIds: [orgId] };
  }

  return { orgIds: null };
}

// Resolve an alert and enforce BOTH tenancy axes (mirrors the web helper in
// routes/alerts/helpers.ts):
//  - org axis (RLS-backed) via ensureOrgAccess.
//  - site axis (app-layer ONLY — RLS does NOT enforce it): a site-restricted
//    org user (`perms.allowedSiteIds` set) must not read/act on an alert whose
//    device lives in a site outside their allowlist. Deviceless (org-wide)
//    alerts stay visible; out-of-site alerts return null so the handler surfaces
//    a 404 (no oracle distinguishing "absent" from "forbidden"). Unrestricted
//    callers (partner/system scope, or org users with no site restriction —
//    `allowedSiteIds` undefined) are unaffected.
async function getAlertWithOrgCheck(
  alertId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>,
  perms?: UserPermissions
) {
  const [alert] = await db
    .select()
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) {
    return null;
  }

  const hasAccess = await ensureOrgAccess(alert.orgId, auth);
  if (!hasAccess) {
    return null;
  }

  // Site-axis gate. Only restricted callers (allowedSiteIds set) are narrowed.
  // Deviceless alerts are org-wide and not site-bound, so they pass.
  if (perms?.allowedSiteIds && alert.deviceId) {
    const [device] = await db
      .select({ siteId: devices.siteId })
      .from(devices)
      .where(eq(devices.id, alert.deviceId))
      .limit(1);
    if (typeof device?.siteId !== 'string' || !canAccessSite(perms, device.siteId)) {
      return null;
    }
  }

  return alert;
}

async function resolveSiteAllowedDeviceIds(orgId: string, perms: UserPermissions | undefined): Promise<string[] | null> {
  if (!perms?.allowedSiteIds) return null;
  // Ephemeral Quick Support devices sit in the partner's hidden 'quick_support'
  // org, which deliberately stays inside accessibleOrgIds — exclude them here so
  // they never enter a site-allowed device set. (Applies to every mobile
  // enumeration below; by-id lookups are left alone.)
  const orgDevices = await db.select({ id: devices.id, siteId: devices.siteId }).from(devices).where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)));
  return orgDevices.filter((d) => typeof d.siteId === 'string' && canAccessSite(perms, d.siteId)).map((d) => d.id);
}

// Validation schemas
const registerDeviceSchema = z.object({
  deviceId: z.string().min(1).max(255),
  platform: z.enum(['ios', 'android']),
  fcmToken: z.string().min(1).optional(),
  apnsToken: z.string().min(1).optional(),
  model: z.string().optional(),
  osVersion: z.string().optional(),
  appVersion: z.string().optional()
}).superRefine((data, ctx) => {
  if (data.platform === 'ios' && !data.apnsToken) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'apnsToken is required for iOS devices' });
  }
  if (data.platform === 'android' && !data.fcmToken) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fcmToken is required for Android devices' });
  }
});

const registerPushTokenSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android'])
});

const unregisterPushTokenSchema = z.object({
  token: z.string().min(1)
});

const updateDeviceSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
  quietHours: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
    timezone: z.string().min(1).optional()
  }).nullable().optional()
});

const inboxQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
  status: z.enum(['active', 'acknowledged', 'resolved', 'suppressed', 'dismissed']).optional(),
  orgId: z.string().guid().optional()
});

const resolveAlertSchema = z.object({
  note: z.string().optional()
});

const listDevicesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  cursor: z.string().optional(),
  orgId: z.string().guid().optional(),
  status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
  search: z.string().optional()
});

const deviceActionSchema = z.object({
  action: z.enum(['reboot', 'wake', 'run_script']),
  scriptId: z.string().guid().optional(),
  // #3409 PR2 Task 7: the ONE script-parameter schema (@breeze/shared).
  parameters: scriptParametersSchema.optional()
}).superRefine((data, ctx) => {
  if (data.action === 'run_script' && !data.scriptId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scriptId is required for run_script' });
  }
});

const summaryQuerySchema = z.object({
  orgId: z.string().guid().optional()
});

// Apply auth middleware to all routes
mobileRoutes.use('*', authMiddleware);

// POST /notifications/register - Compatibility push token registration endpoint
mobileRoutes.post(
  '/notifications/register',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', registerPushTokenSchema),
  async (c) => {
    const auth = c.get('auth');
    const { token, platform } = c.req.valid('json');
    const now = new Date();

    // #2913: key the row on the phone's per-install id (the value the
    // blocked-device middleware looks up) rather than on the push-token hash.
    // The hash remains the fallback for header-less callers and the id we
    // adopt FROM.
    //
    // Precedence MUST mirror mobileDeviceBlockedMiddleware: the SIGNED `mdid`
    // claim first, the header only for pre-binding tokens. Keying off the raw
    // header alone would let a client authenticate as install X and then
    // register its row under install Y, so the middleware's lookup on X misses
    // forever — the same inert control this issue is about, re-opened by the
    // very client it constrains (SR-001: the header is forgeable).
    const installationId =
      typeof auth.token?.mdid === 'string' && auth.token.mdid.length > 0
        ? auth.token.mdid
        : readMobileDeviceId(c);
    const legacyDeviceId = derivePushDeviceId(auth.user.id, platform, token);
    const plan = await planMobileDeviceId({
      userId: auth.user.id,
      installationId,
      legacyDeviceId,
      platform,
      token
    });

    if (
      plan.fallbackReason &&
      registrationFallbackThrottle.shouldReport(`${plan.fallbackReason}:${auth.user.id}`)
    ) {
      // We could not key this phone on its installation id, so the blocked-
      // device check still cannot see it. Say so rather than leaving another
      // silently inert control behind (#2913). Throttled: a phone stuck in
      // this state re-registers on every app foreground.
      captureMessage(
        'mobile push registration fell back to push-derived device id — block enforcement stays inert for this caller',
        {
          eventCode: 'mobile_push_registration_fallback',
          tags: { mobile_registration_reason: plan.fallbackReason },
        }
      );
    }

    const tokenFields = {
      fcmToken: platform === 'android' ? token : null,
      apnsToken: platform === 'ios' ? token : null,
      notificationsEnabled: true,
      lastActiveAt: now,
      updatedAt: now
    };

    let device: typeof mobileDevices.$inferSelect | undefined;
    let displacedRowId: string | null = null;

    // Another account's ACTIVE row already holds this installation id (the
    // phone changed hands). Park it under a salted id so the caller can take
    // the clean key without inheriting the previous user's row.
    //
    // Atomic with the insert: a displace that committed while the insert
    // failed would leave the previous owner re-keyed for nothing, and their
    // live tokens still carry the ORIGINAL id as their signed `mdid` — so a
    // later block on that row would match nothing. Roll both back together.
    //
    // The displaced row also loses its push tokens: they are the same
    // OS-minted tokens the caller just submitted (that is what proved the
    // shared handset), so leaving them would fan the previous user's
    // notifications out to the new user's phone.
    if (plan.displaceRowId) {
      const displaceRowId = plan.displaceRowId;
      let sawConflict = false;
      let displacedRows = 0;
      device = await db.transaction(async (tx) => {
        // `.returning()` is load-bearing: the WHERE re-checks state that
        // planMobileDeviceId read a moment earlier, so a row blocked, deleted
        // or re-keyed in between matches nothing. Without the row count we
        // would report a displacement — and a token-clearing — that never
        // happened. A 0-row write under FORCE RLS is exactly the silent-write
        // class the repo guards elsewhere, and `tx` bypasses that guard.
        const displaced = await tx
          .update(mobileDevices)
          .set({
            deviceId: saltDeviceId(plan.deviceId, now.getTime()),
            fcmToken: null,
            apnsToken: null,
            notificationsEnabled: false,
            updatedAt: now
          })
          .where(
            and(
              eq(mobileDevices.id, displaceRowId),
              eq(mobileDevices.status, 'active'),
              ne(mobileDevices.userId, auth.user.id)
            )
          )
          .returning({ id: mobileDevices.id });
        displacedRows = displaced.length;

        const [inserted] = await tx
          .insert(mobileDevices)
          .values({ userId: auth.user.id, deviceId: plan.deviceId, platform, ...tokenFields })
          .returning();

        if (!inserted) {
          // Abort so the displacement is rolled back rather than stranding the
          // previous owner under a salted id for a registration that failed.
          // The flag — not the thrown value — is what the catch keys on: the
          // driver may wrap or replace the error on rollback, and a mis-typed
          // sentinel would surface as a 500 instead of the intended 409.
          sawConflict = true;
          throw new MobileDeviceRegistrationConflict();
        }
        return inserted;
      }).catch((err: unknown) => {
        if (sawConflict || isPgUniqueViolation(err)) {
          return undefined;
        }
        throw err;
      });

      if (!device) {
        return registrationConflict(c, auth.user.id, 'displace-insert-conflict');
      }
      // Only claim a displacement that actually moved a row.
      displacedRowId = displacedRows > 0 ? displaceRowId : null;
    }

    // Adoption: rewrite this phone's existing push-derived row onto the
    // installation id, keeping its uuid PK so notification preferences and
    // every FK pointing at it survive. A no-op result means a concurrent
    // request already adopted (or blocked) the row — fall through to the
    // upsert, whose conflict path converges on the same row.
    //
    // The 23505 recovery REQUIRES its own transaction. authMiddleware wraps the
    // whole request in one (`withDbAccessContext` -> `db.transaction`), and the
    // ambient `db` resolves to it — so a unique violation raised here would
    // abort the REQUEST transaction, leaving the fallback upsert below to die
    // with 25P02 and the mapped response discarded in favour of a raw 500.
    // Nesting yields a SAVEPOINT, so the conflict rolls back to it and the
    // outer transaction survives to run the upsert.
    if (plan.adoptRowId) {
      const adoptRowId = plan.adoptRowId;
      device = await db
        .transaction(async (tx) => {
          const [adopted] = await tx
            .update(mobileDevices)
            .set({ deviceId: plan.deviceId, platform, ...tokenFields })
            .where(
              and(
                eq(mobileDevices.id, adoptRowId),
                eq(mobileDevices.userId, auth.user.id),
                eq(mobileDevices.status, 'active')
              )
            )
            .returning();
          return adopted;
        })
        .catch((err: unknown) => {
          // A concurrent registration inserted the installation-id row between
          // our read and this update. Not an error — the upsert below lands on
          // that row instead, leaving the legacy row to be adopted next time.
          if (isPgUniqueViolation(err)) return undefined;
          throw err;
        });
    }

    if (!device) {
      [device] = await db
        .insert(mobileDevices)
        .values({
          userId: auth.user.id,
          deviceId: plan.deviceId,
          platform,
          ...tokenFields
        })
        .onConflictDoUpdate({
          target: mobileDevices.deviceId,
          // `userId` is deliberately NOT reassigned here: with per-install
          // keying a conflict can now be another account's row, and silently
          // moving it to the caller would redirect that user's pushes. The
          // cross-user case is handled by the displace branch above.
          set: tokenFields,
          // Belt-and-suspenders: never overwrite a blocked row via the
          // conflict path; the salted-id branch in planMobileDeviceId keeps us
          // out of this case entirely, but if a race lands a fresh row in
          // between we still want the conflict update to skip blocked rows.
          setWhere: sql`${mobileDevices.status} = 'active' AND ${mobileDevices.userId} = ${auth.user.id}`
        })
        .returning();
    }

    if (!device) {
      // The conflict guard matched no row: the id is held by a blocked row or
      // by another account. Returning `{ success: true }` here (the previous
      // behaviour) reported a registration that never happened, so the phone
      // silently stopped receiving pushes.
      return registrationConflict(c, auth.user.id, 'upsert-guard-matched-no-row');
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'mobile.push.register',
      resourceType: 'mobile_device',
      resourceId: device?.id,
      resourceName: device?.deviceId,
      // A displacement re-keys ANOTHER account's row. That must never be an
      // unrecorded side effect of a routine push registration.
      details: displacedRowId
        ? { platform, displacedMobileDeviceId: displacedRowId }
        : { platform }
    });

    return c.json({ success: true });
  }
);

// POST /notifications/unregister - Compatibility push token unregister endpoint
mobileRoutes.post(
  '/notifications/unregister',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', unregisterPushTokenSchema),
  async (c) => {
    const auth = c.get('auth');
    const { token } = c.req.valid('json');

    const removed = await db
      .delete(mobileDevices)
      .where(
        and(
          eq(mobileDevices.userId, auth.user.id),
          or(eq(mobileDevices.fcmToken, token), eq(mobileDevices.apnsToken, token))
        )
      )
      .returning();

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'mobile.push.unregister',
      resourceType: 'mobile_device',
      details: { removedCount: removed.length }
    });

    return c.json({ success: true });
  }
);

// POST /devices - Register mobile device for push
mobileRoutes.post(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', registerDeviceSchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');
    const fcmToken = data.platform === 'android' ? data.fcmToken : null;
    const apnsToken = data.platform === 'ios' ? data.apnsToken : null;
    const now = new Date();

    const updateSet: Record<string, unknown> = {
      userId: auth.user.id,
      platform: data.platform,
      fcmToken,
      apnsToken,
      lastActiveAt: now,
      updatedAt: now
    };
    if (data.model !== undefined) updateSet.model = data.model;
    if (data.osVersion !== undefined) updateSet.osVersion = data.osVersion;
    if (data.appVersion !== undefined) updateSet.appVersion = data.appVersion;

    // `device_id` is globally unique. Without an ownership guard the conflict
    // path below would happily reassign another user's row to the caller
    // (and RLS permits it for same-tenant callers). Refuse up front if the
    // id is registered to anyone else — never touch a row we don't own. SR-002.
    const [existing] = await db
      .select({ status: mobileDevices.status, userId: mobileDevices.userId })
      .from(mobileDevices)
      .where(eq(mobileDevices.deviceId, data.deviceId))
      .limit(1);
    if (existing && existing.userId !== auth.user.id) {
      return c.json(
        {
          error: 'This device is already registered to another account.',
          code: 'device_owned_by_other',
        },
        409
      );
    }

    // Same blocked-row protection as /notifications/register: if our own row
    // for this deviceId is `blocked`, salt the id so the re-pair lands in a
    // fresh row instead of reactivating the blocked one.
    // saltDeviceId truncates the base so the result still fits varchar(255) —
    // `deviceId` is accepted up to the full 255 chars, so a naive
    // `${id}-${ts}` overflows the column and 500s (22001).
    const insertDeviceId = existing?.status === 'blocked'
      ? saltDeviceId(data.deviceId, now.getTime())
      : data.deviceId;

    const [device] = await db
      .insert(mobileDevices)
      .values({
        userId: auth.user.id,
        deviceId: insertDeviceId,
        platform: data.platform,
        model: data.model,
        osVersion: data.osVersion,
        appVersion: data.appVersion,
        fcmToken,
        apnsToken,
        lastActiveAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: mobileDevices.deviceId,
        set: updateSet,
        // Defense-in-depth against a race between the ownership check above
        // and this upsert: the update can only ever touch an active row the
        // caller already owns. A foreign/blocked row yields 0 updated rows.
        setWhere: sql`${mobileDevices.status} = 'active' AND ${mobileDevices.userId} = ${auth.user.id}`
      })
      .returning();

    if (!device) {
      // Conflict fired but the owned-and-active guard matched no row — the id
      // was taken by another user between the check and the upsert. Never
      // fall through to a 201 with a null body.
      return c.json(
        {
          error: 'This device is already registered to another account.',
          code: 'device_owned_by_other',
        },
        409
      );
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'mobile.device.register',
      resourceType: 'mobile_device',
      resourceId: device?.id,
      resourceName: device?.deviceId,
      details: { platform: data.platform }
    });

    return c.json(device, 201);
  }
);

// PATCH /devices/:id/settings - Update mobile notification settings
mobileRoutes.patch(
  '/devices/:id/settings',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateDeviceSettingsSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    if (data.enabled === undefined && data.severities === undefined && data.quietHours === undefined) {
      return c.json({ error: 'No settings provided' }, 400);
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date()
    };

    if (data.enabled !== undefined) {
      updates.notificationsEnabled = data.enabled;
    }
    if (data.severities !== undefined) {
      updates.alertSeverities = data.severities;
    }
    if (data.quietHours !== undefined) {
      updates.quietHours = data.quietHours;
    }

    const [updated] = await db
      .update(mobileDevices)
      .set(updates)
      .where(
        and(
          eq(mobileDevices.id, deviceId),
          eq(mobileDevices.userId, auth.user.id)
        )
      )
      .returning();

    if (!updated) {
      return c.json({ error: 'Mobile device not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'mobile.device.settings.update',
      resourceType: 'mobile_device',
      resourceId: updated.id,
      resourceName: updated.deviceId,
      details: { changedFields: Object.keys(data) }
    });

    return c.json(updated);
  }
);

// DELETE /devices/:id - Unregister mobile device
mobileRoutes.delete(
  '/devices/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;

    const [deleted] = await db
      .delete(mobileDevices)
      .where(
        and(
          eq(mobileDevices.id, deviceId),
          eq(mobileDevices.userId, auth.user.id)
        )
      )
      .returning();

    if (!deleted) {
      return c.json({ error: 'Mobile device not found' }, 404);
    }

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'mobile.device.unregister',
      resourceType: 'mobile_device',
      resourceId: deleted.id,
      resourceName: deleted.deviceId
    });

    return c.json({ success: true });
  }
);

// GET /alerts/inbox - Get alert inbox with status filter
//
// Pagination is dual-mode (additive):
//   - Legacy: page+limit; response carries `total` so callers can show "N of M".
//   - Cursor: opaque `cursor` from a prior response's `nextCursor`; keyset on
//     (triggered_at DESC, id DESC). Stable under concurrent inserts and cheap
//     on deep pages. When `cursor` is supplied, `page` is ignored.
//
// `nextCursor` is computed on EVERY response, cursor or not — including the
// very first page/limit request (#3770). `triggered_at` is NOT NULL and
// write-once (never updated after insert), so ordering never needs a
// NULLS-LAST branch or an immutable-column swap the way `/devices` does
// below. It DOES need full precision: Postgres keeps six fractional digits,
// but a JS `Date` — what a plain Drizzle column read produces — only holds
// three, so round-tripping the cursor through one can truncate a boundary
// and skip rows sitting between the truncated value and the next real one.
// `triggeredAtKey` reads the same column back as raw microsecond text via
// `to_char` instead, and that text — never a `Date` — is what goes into the
// token and the keyset predicate.
mobileRoutes.get(
  '/alerts/inbox',
  requireScope('organization', 'partner', 'system'),
  requireMobileAlertRead,
  zValidator('query', inboxQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const cursor = decodeTimestampCursor(query.cursor);

    const orgCheck = await getOrgIdsForAuth(auth, query.orgId);
    if (orgCheck.error) {
      return c.json({ error: orgCheck.error.message }, orgCheck.error.status as 400 | 403 | 404);
    }

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgCheck.orgIds !== null) {
      if (orgCheck.orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0, nextCursor: null } });
      }
      conditions.push(inArray(alerts.orgId, orgCheck.orgIds));
    }

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && auth.orgId) {
      const allowedDeviceIds = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
      if (!allowedDeviceIds || allowedDeviceIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0, nextCursor: null } });
      }
      conditions.push(inArray(alerts.deviceId, allowedDeviceIds));
    }

    if (query.status) {
      conditions.push(eq(alerts.status, query.status));
    } else {
      // Dismissed alerts are permanently closed — hidden unless asked for by name.
      conditions.push(ne(alerts.status, 'dismissed'));
    }

    if (cursor) {
      conditions.push(
        sql`(${alerts.triggeredAt} < ${cursor.key}::timestamp OR (${alerts.triggeredAt} = ${cursor.key}::timestamp AND ${alerts.id} < ${cursor.id}::uuid))`
      );
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(alerts)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Always over-fetch by one to know whether another page exists — not
    // gated on `cursor`, or a cold-start caller's first response could never
    // carry a usable `nextCursor` (#3770).
    const fetchLimit = limit + 1;
    const alertRows = await db
      .select({
        id: alerts.id,
        orgId: alerts.orgId,
        status: alerts.status,
        severity: alerts.severity,
        title: alerts.title,
        message: alerts.message,
        triggeredAt: alerts.triggeredAt,
        // Full microsecond-precision text of the same column, for the cursor
        // only — see the route comment above. Never surfaced in `data`.
        triggeredAtKey: sql<string>`to_char(${alerts.triggeredAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
        acknowledgedAt: alerts.acknowledgedAt,
        resolvedAt: alerts.resolvedAt,
        deviceId: alerts.deviceId,
        deviceHostname: devices.hostname,
        deviceOsType: devices.osType,
        deviceStatus: devices.status,
        // Alerts carry no type/category of their own — only a rule reference.
        // The category one hop away on the rule's template is the closest
        // thing mobile has to a meaningful alert "type" (#4535). Nullable:
        // alerts can be created without a rule.
        category: alertTemplates.category
      })
      .from(alerts)
      .leftJoin(devices, eq(alerts.deviceId, devices.id))
      .leftJoin(alertRules, eq(alerts.ruleId, alertRules.id))
      .leftJoin(alertTemplates, eq(alertRules.templateId, alertTemplates.id))
      .where(whereCondition)
      .orderBy(desc(alerts.triggeredAt), desc(alerts.id))
      .limit(fetchLimit)
      .offset(cursor ? 0 : offset);

    const hasMore = alertRows.length > limit;
    const trimmedRows = hasMore ? alertRows.slice(0, limit) : alertRows;
    let nextCursor: string | null = null;
    const last = trimmedRows[trimmedRows.length - 1];
    if (hasMore && last) {
      nextCursor = encodeCursor(last.triggeredAtKey, last.id);
    }

    const data = trimmedRows.map(alert => ({
      id: alert.id,
      orgId: alert.orgId,
      status: alert.status,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      triggeredAt: alert.triggeredAt,
      acknowledgedAt: alert.acknowledgedAt,
      resolvedAt: alert.resolvedAt,
      category: alert.category ?? null,
      device: alert.deviceId ? {
        id: alert.deviceId,
        hostname: alert.deviceHostname,
        osType: alert.deviceOsType,
        status: alert.deviceStatus
      } : null
    }));

    return c.json({
      data,
      pagination: { page, limit, total, nextCursor }
    });
  }
);

// POST /alerts/:id/acknowledge - Quick acknowledge from mobile
mobileRoutes.post(
  '/alerts/:id/acknowledge',
  requireScope('organization', 'partner', 'system'),
  requireMobileAlertAcknowledge,
  async (c) => {
    const auth = c.get('auth');
    const alertId = c.req.param('id')!;
    const perms = c.get('permissions') as UserPermissions | undefined;

    const alert = await getAlertWithOrgCheck(alertId, auth, perms);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    // Fast path with a specific message. It is NOT the concurrency control — the
    // compare-and-swap below is. See the twin handler in routes/alerts/alerts.ts
    // for why `acknowledged` carries the CAS loser's 409 rather than a 400.
    if (alert.status === 'acknowledged') {
      return c.json({ error: 'Alert is already acknowledged' }, 409);
    }
    if (alert.status !== 'active') {
      return c.json({ error: `Cannot acknowledge alert with status: ${alert.status}` }, 400);
    }

    const acknowledgedAt = new Date();
    // Winner-takes-all (#4101) — same predicate as the twin handler in
    // routes/alerts/alerts.ts. This path additionally never looked at the
    // `RETURNING` at all (`updated?.id ?? alertId`), so a write that matched zero
    // rows — a lost race, or a row this tenant context cannot see, which raises no
    // error under breeze_app RLS — still published `alert.acknowledged`, still fed
    // the ML loop and still answered 200 with a null body.
    const [updated] = await db
      .update(alerts)
      .set({
        status: 'acknowledged',
        acknowledgedAt,
        acknowledgedBy: auth.user.id
      })
      .where(buildAcknowledgeAlertCas(alertId))
      .returning();
    if (!updated) {
      return c.json({ error: ALERT_ACKNOWLEDGE_CAS_LOST_MESSAGE }, 409);
    }

    try {
      await publishEvent(
        'alert.acknowledged',
        alert.orgId,
        {
          alertId: updated.id,
          ruleId: alert.ruleId,
          deviceId: alert.deviceId,
          acknowledgedBy: auth.user.id
        },
        'mobile-routes',
        { userId: auth.user.id }
      );
    } catch (error) {
      console.error('[MobileRoutes] Failed to publish alert.acknowledged event:', error);
    }

    await emitAlertStateFeedback({
      orgId: alert.orgId,
      alertId: updated.id,
      eventType: 'alert.acknowledged',
      outcome: 'acknowledged',
      actorUserId: auth.user.id,
      occurredAt: acknowledgedAt,
      metadata: {
        source: 'mobile.alerts',
        previousStatus: alert.status,
      },
    });

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'mobile.alert.acknowledge',
      resourceType: 'alert',
      resourceId: updated.id,
      resourceName: updated.title
    });

    return c.json(updated);
  }
);

// POST /alerts/:id/resolve - Quick resolve with optional note
mobileRoutes.post(
  '/alerts/:id/resolve',
  requireScope('organization', 'partner', 'system'),
  requireMobileAlertWrite,
  zValidator('json', resolveAlertSchema),
  async (c) => {
    const auth = c.get('auth');
    const alertId = c.req.param('id')!;
    const data = c.req.valid('json');
    const perms = c.get('permissions') as UserPermissions | undefined;

    const alert = await getAlertWithOrgCheck(alertId, auth, perms);
    if (!alert) {
      return c.json({ error: 'Alert not found' }, 404);
    }

    // Fast path with a specific message. It is NOT the concurrency control — the
    // compare-and-swap below is. A tech racing the auto-resolve sweep clears this.
    if (alert.status === 'resolved') {
      return c.json({ error: 'Alert is already resolved' }, 409);
    }
    if (alert.status === 'dismissed') {
      // Dismissed is terminal (matches POST /alerts/:id/resolve): resolving it
      // would silently un-dismiss and let synthetic evaluators re-create it.
      return c.json({ error: 'Cannot resolve a dismissed alert' }, 400);
    }

    const resolvedAt = new Date();
    // Winner-takes-all (#4094) — same predicate as `resolveAlert`. See the twin
    // handler in routes/alerts/alerts.ts for the full rationale.
    const [updated] = await db
      .update(alerts)
      .set({
        status: 'resolved',
        resolvedAt,
        resolvedBy: auth.user.id,
        resolutionNote: data.note
      })
      .where(buildResolveAlertCas(alertId))
      .returning();
    if (!updated) {
      // Lost the race: another request reached a terminal status first. The
      // cooldown/event/feedback/audit fan-out below belongs to that caller only.
      return c.json({ error: ALERT_CAS_LOST_MESSAGE }, 409);
    }

    try {
      if (alert.ruleId) {
        const [rule] = await db
          .select()
          .from(alertRules)
          .where(eq(alertRules.id, alert.ruleId))
          .limit(1);

        if (rule) {
          const [template] = await db
            .select()
            .from(alertTemplates)
            .where(eq(alertTemplates.id, rule.templateId))
            .limit(1);

          const overrides = (rule.overrideSettings as Record<string, unknown> | null) ?? null;
          const cooldownMinutes = (overrides?.cooldownMinutes as number) ??
            template?.cooldownMinutes ?? 15;
          await setCooldown(alert.ruleId, alert.deviceId, cooldownMinutes);
        }
      } else if (alert.configPolicyId) {
        const ctx = alert.context as Record<string, unknown> | null;
        const cooldownMinutes = typeof ctx?.cooldownMinutes === 'number' ? ctx.cooldownMinutes : 5;
        await markConfigPolicyRuleCooldown(alert.configPolicyId, alert.deviceId, cooldownMinutes);
      }
    } catch (error) {
      console.error('[MobileRoutes] Failed to set alert cooldown on resolve:', error);
    }

    try {
      await publishEvent(
        'alert.resolved',
        alert.orgId,
        {
          alertId: updated.id,
          ruleId: alert.ruleId,
          deviceId: alert.deviceId,
          resolvedBy: auth.user.id,
          resolutionNote: data.note,
          resolvedAt: resolvedAt.toISOString(),
          triggeredAt: alert.triggeredAt.toISOString(),
        },
        'mobile-routes',
        { userId: auth.user.id }
      );
    } catch (error) {
      console.error('[MobileRoutes] Failed to publish alert.resolved event:', error);
    }

    await emitAlertStateFeedback({
      orgId: alert.orgId,
      alertId: updated.id,
      eventType: 'alert.resolved',
      outcome: 'resolved',
      actorUserId: auth.user.id,
      occurredAt: resolvedAt,
      metadata: {
        source: 'mobile.alerts',
        previousStatus: alert.status,
        hasResolutionNote: Boolean(data.note),
      },
    });

    writeRouteAudit(c, {
      orgId: alert.orgId,
      action: 'mobile.alert.resolve',
      resourceType: 'alert',
      resourceId: updated.id,
      resourceName: updated.title,
      details: { hasNote: Boolean(data.note) }
    });

    return c.json(updated);
  }
);

// GET /devices - Get simplified device list for mobile
//
// Pagination is dual-mode (additive):
//   - Legacy: an EXPLICIT `?page=N` (no `cursor`); response carries `total`
//     so callers can show "N of M". Keeps the pre-existing `last_seen_at
//     DESC` order, and never returns a `nextCursor` — this contract doesn't
//     upgrade into cursor mode mid-walk (ordering differs — see below).
//   - Cursor: the DEFAULT — no `page` given, or an explicit `cursor` from a
//     prior response's `nextCursor`. Keyset on `(hostname ASC, id ASC)`,
//     ported from `routes/devices/core.ts`'s cursor mode rather than
//     `last_seen_at`, because `last_seen_at` is both nullable (Postgres
//     sorts NULLs first on DESC with no NULLS LAST clause, so never-checked-
//     in devices would lead the walk) and mutable (every heartbeat rewrites
//     it, so a device can cross the page boundary mid-walk and be skipped
//     entirely). `hostname` is NOT NULL and effectively immutable, so the
//     keyset is stable under concurrent heartbeats. This is a genuine
//     ordering change for any caller that doesn't pass `page` (#3770) —
//     intentional; the mobile client already re-sorts this list client-side
//     (see `screens/devices/deviceListFilters.ts`) and never reads
//     `nextCursor` today, so it is unaffected either way.
mobileRoutes.get(
  '/devices',
  requireScope('organization', 'partner', 'system'),
  requireMobileDeviceRead,
  zValidator('query', listDevicesSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    // Cursor mode is the default (matches `routes/devices/core.ts`): an
    // explicit `?page=N` with no `cursor` opts into the legacy contract.
    const isCursorMode = query.page === undefined || query.cursor !== undefined;
    const cursor = decodeCursor(query.cursor);

    const orgCheck = await getOrgIdsForAuth(auth, query.orgId);
    if (orgCheck.error) {
      return c.json({ error: orgCheck.error.message }, orgCheck.error.status as 400 | 403 | 404);
    }

    const conditions: ReturnType<typeof eq>[] = [eq(devices.isEphemeral, false)];
    if (orgCheck.orgIds !== null) {
      if (orgCheck.orgIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0, nextCursor: null } });
      }
      conditions.push(inArray(devices.orgId, orgCheck.orgIds));
    }

    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds) {
      if (perms.allowedSiteIds.length === 0) {
        return c.json({ data: [], pagination: { page, limit, total: 0, nextCursor: null } });
      }
      conditions.push(inArray(devices.siteId, perms.allowedSiteIds));
    }

    if (query.status) {
      conditions.push(eq(devices.status, query.status));
    }

    if (query.search) {
      conditions.push(like(devices.hostname, `%${escapeLike(query.search)}%`));
    }

    if (!query.status) {
      conditions.push(sql`${devices.status} != 'decommissioned'`);
    }

    if (cursor) {
      // Tuple comparison on a NOT NULL pair needs no NULLS branch — unlike
      // the previous `last_seen_at` keyset, there's only one phase to walk.
      conditions.push(
        sql`(${devices.hostname}, ${devices.id}) > (${cursor.key}, ${cursor.id}::uuid)`
      );
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(devices)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Always over-fetch by one to know whether another page exists — not
    // gated on `cursor`, or a cold-start caller's first response could never
    // carry a usable `nextCursor` (#3770).
    const fetchLimit = limit + 1;
    const deviceRows = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        siteId: devices.siteId,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt
      })
      .from(devices)
      .where(whereCondition)
      .orderBy(...(isCursorMode ? [asc(devices.hostname), asc(devices.id)] : [desc(devices.lastSeenAt), desc(devices.id)]))
      .limit(fetchLimit)
      .offset(cursor ? 0 : offset);

    const hasMore = deviceRows.length > limit;
    const items = hasMore ? deviceRows.slice(0, limit) : deviceRows;
    // Legacy `?page=N` never returns a nextCursor — its order (`last_seen_at
    // DESC`) doesn't match the keyset above, so a cursor minted from it would
    // silently switch a walking client onto a different ordering (#3770).
    let nextCursor: string | null = null;
    if (isCursorMode) {
      const last = items[items.length - 1];
      if (hasMore && last) {
        nextCursor = encodeCursor(last.hostname, last.id);
      }
    }

    return c.json({
      data: items,
      pagination: { page, limit, total, nextCursor }
    });
  }
);

// POST /devices/:id/actions - Quick actions (reboot, wake, run_script)
mobileRoutes.post(
  '/devices/:id/actions',
  requireScope('organization', 'partner', 'system'),
  requireMobileDeviceExecute,
  requireMfa(),
  zValidator('json', deviceActionSchema),
  requireScriptExecuteForRunScript,
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    const permissions = c.get('permissions') as UserPermissions | undefined;
    if (permissions?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(permissions, device.siteId))) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    if (device.status === 'decommissioned') {
      return c.json({ error: 'Device is decommissioned' }, 400);
    }

    if (data.action === 'run_script') {
      const result = await executeScriptOnDevices({
        scriptId: data.scriptId as string,
        deviceIds: [device.id],
        parameters: data.parameters as Record<string, unknown> | undefined,
        triggerType: 'manual',
        auth,
        permissions,
      });

      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }

      const admission = result.admission.targets.find(
        (target) => target.requestedDeviceId === device.id,
      );
      if (!admission || admission.admission !== 'admitted' || !admission.executionId || !admission.commandId) {
        const status = admission?.reasonCode === 'maintenance_suppressed' ? 409 : 422;
        return c.json(
          {
            admission: admission?.admission ?? 'denied',
            reasonCode: admission?.reasonCode ?? 'not_found_or_inaccessible',
          },
          status,
        );
      }
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'mobile.device.action',
        resourceType: 'device',
        resourceId: device.id,
        resourceName: device.hostname,
        details: {
          action: data.action,
          requestId: result.admission.requestId,
          scriptId: result.script.id,
          executionId: admission.executionId,
          commandId: admission.commandId,
          // #3409 PR3 §2.2 — bound parameter keys whose caller-supplied value
          // was dropped in favour of the binding. KEYS ONLY, never values.
          // Named distinctly rather than folded into an existing key: audit
          // `details` is an untyped shared bag and overloading a generic name
          // there has already caused one cross-meaning collision (`deviceId`).
          ignoredParameterKeys: result.ignoredParameters,
        },
      });

      return c.json({
        action: data.action,
        executionId: admission.executionId,
        commandId: admission.commandId,
        // This endpoint accepts `parameters`, so the mobile client is just as
        // able to supply a value for a bound key as the web one — the warning
        // is surfaced here for the same reason and in the same shape as
        // POST /scripts/:id/execute (omitted when empty, so the clean-run
        // response shape mobile already parses is unchanged). The single-
        // device shape needs no aggregation: the fan-out is one device.
        ignoredParameters: result.ignoredParameters.length > 0 ? result.ignoredParameters : undefined,
      }, 201);
    }

    // Wake-on-LAN: dispatch via the relay-aware service. Audit row is written
    // by the service against the target device; no route-level audit here to
    // avoid duplication.
    if (data.action === 'wake') {
      const wake = await dispatchWake(device.id, auth.user.id, {
        ipAddress: getTrustedClientIpOrUndefined(c),
        userAgent: c.req.header('user-agent'),
      });
      if (!wake.ok) {
        return c.json({ error: wake.message, code: wake.code }, 412);
      }
      return c.json({
        action: 'wake',
        commandId: wake.commandId,
        wakeAttemptId: wake.wakeAttemptId,
        relay: { deviceId: wake.relayDeviceId, hostname: wake.relayHostname },
        network: wake.network,
        broadcast: wake.broadcast,
        macs: wake.macs,
      }, 202);
    }

    let cmdResult;
    try {
      await assertDeviceExecuteAllowed(device.id, data.action, auth.user.id);
      cmdResult = await db
        .insert(deviceCommands)
        .values({
          deviceId: device.id,
          type: data.action,
          payload: { source: 'mobile' },
          status: 'pending',
          createdBy: auth.user.id
        })
        .returning();
    } catch (e) {
      if (e instanceof TrustDeniedError) {
        return c.json(
          trustDenyBody({
            allow: false,
            code: e.code,
            capability: 'device_execute',
            reason: e.reason,
          }, false),
          403,
        );
      }
      throw e;
    }
    const cmd = cmdResult[0];

    if (!cmd) {
      return c.json({ error: 'Failed to create command' }, 500);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'mobile.device.action',
      resourceType: 'device',
      resourceId: device.id,
      resourceName: device.hostname,
      details: {
        action: data.action,
        commandId: cmd.id
      }
    });

    return c.json({
      action: data.action,
      commandId: cmd.id
    }, 201);
  }
);

// GET /summary - Get dashboard summary
mobileRoutes.get(
  '/summary',
  requireScope('organization', 'partner', 'system'),
  requireMobileDeviceRead,
  requireMobileAlertRead,
  zValidator('query', summaryQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgCheck = await getOrgIdsForAuth(auth, query.orgId);
    if (orgCheck.error) {
      return c.json({ error: orgCheck.error.message }, orgCheck.error.status as 400 | 403 | 404);
    }

    const deviceConditions: ReturnType<typeof eq>[] = [eq(devices.isEphemeral, false)];
    if (orgCheck.orgIds !== null) {
      if (orgCheck.orgIds.length === 0) {
        return c.json({
          devices: { total: 0, online: 0, offline: 0, maintenance: 0 },
          alerts: { total: 0, active: 0, acknowledged: 0, resolved: 0, critical: 0 }
        });
      }
      deviceConditions.push(inArray(devices.orgId, orgCheck.orgIds));
    }

    // Site-axis narrowing (app-layer only; RLS does NOT enforce site isolation).
    // Mirrors /devices list (~891-897) and /alerts/inbox (~595-601) in this file.
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds) {
      if (perms.allowedSiteIds.length === 0) {
        return c.json({
          devices: { total: 0, online: 0, offline: 0, maintenance: 0 },
          alerts: { total: 0, active: 0, acknowledged: 0, resolved: 0, critical: 0 }
        });
      }
      deviceConditions.push(inArray(devices.siteId, perms.allowedSiteIds));
    }

    const deviceWhere = deviceConditions.length > 0 ? and(...deviceConditions) : undefined;

    const deviceStats = await db
      .select({
        total: sql<number>`count(*)`,
        online: sql<number>`sum(case when ${devices.status} = 'online' then 1 else 0 end)`,
        offline: sql<number>`sum(case when ${devices.status} = 'offline' then 1 else 0 end)`,
        maintenance: sql<number>`sum(case when ${devices.status} = 'maintenance' then 1 else 0 end)`
      })
      .from(devices)
      .where(deviceWhere);

    const alertConditions: ReturnType<typeof eq>[] = [];
    if (orgCheck.orgIds !== null) {
      alertConditions.push(inArray(alerts.orgId, orgCheck.orgIds));
    }
    // Alert site-axis: use resolveSiteAllowedDeviceIds (mirrors /alerts/inbox).
    // Only restrict when we have an org context (partner/system spans multiple orgs).
    if (perms?.allowedSiteIds && auth.orgId) {
      const allowedDeviceIds = await resolveSiteAllowedDeviceIds(auth.orgId, perms);
      if (!allowedDeviceIds || allowedDeviceIds.length === 0) {
        return c.json({
          devices: {
            total: Number(deviceStats[0]?.total ?? 0),
            online: Number(deviceStats[0]?.online ?? 0),
            offline: Number(deviceStats[0]?.offline ?? 0),
            maintenance: Number(deviceStats[0]?.maintenance ?? 0)
          },
          alerts: { total: 0, active: 0, acknowledged: 0, resolved: 0, critical: 0 }
        });
      }
      alertConditions.push(inArray(alerts.deviceId, allowedDeviceIds));
    }
    const alertWhere = alertConditions.length > 0 ? and(...alertConditions) : undefined;

    const alertStats = await db
      .select({
        total: sql<number>`count(*)`,
        active: sql<number>`sum(case when ${alerts.status} = 'active' then 1 else 0 end)`,
        acknowledged: sql<number>`sum(case when ${alerts.status} = 'acknowledged' then 1 else 0 end)`,
        resolved: sql<number>`sum(case when ${alerts.status} = 'resolved' then 1 else 0 end)`,
        critical: sql<number>`sum(case when ${alerts.status} in ('active', 'acknowledged') and ${alerts.severity} = 'critical' then 1 else 0 end)`
      })
      .from(alerts)
      .where(alertWhere);

    return c.json({
      devices: {
        total: Number(deviceStats[0]?.total ?? 0),
        online: Number(deviceStats[0]?.online ?? 0),
        offline: Number(deviceStats[0]?.offline ?? 0),
        maintenance: Number(deviceStats[0]?.maintenance ?? 0)
      },
      alerts: {
        total: Number(alertStats[0]?.total ?? 0),
        active: Number(alertStats[0]?.active ?? 0),
        acknowledged: Number(alertStats[0]?.acknowledged ?? 0),
        resolved: Number(alertStats[0]?.resolved ?? 0),
        critical: Number(alertStats[0]?.critical ?? 0)
      }
    });
  }
);

// GET /search - Unified mobile search across devices, alerts, AI sessions
const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).optional()
});

type SearchResult =
  | {
      kind: 'device';
      id: string;
      title: string;
      subtitle: string;
      meta: {
        orgId: string;
        siteId: string | null;
        hostname: string | null;
        displayName: string | null;
        osType: string | null;
        status: string | null;
        lastSeenAt: string | null;
        siteName: string | null;
      };
    }
  | {
      kind: 'alert';
      id: string;
      title: string;
      subtitle: string;
      meta: {
        orgId: string;
        severity: string;
        status: string;
        deviceId: string | null;
        deviceName: string | null;
        message: string | null;
        triggeredAt: string | null;
      };
    }
  | {
      kind: 'session';
      id: string;
      title: string;
      subtitle: string;
      meta: {
        orgId: string;
        status: string;
        turnCount: number;
        lastActivityAt: string | null;
        createdAt: string | null;
      };
    };

mobileRoutes.get(
  '/search',
  requireScope('organization', 'partner', 'system'),
  // Populates `permissions` so the site narrowing below is live (only
  // requirePermission sets it). DEVICES_READ is granted to every device-viewing role.
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  userRateLimit('mobile-search', 30, 60),
  zValidator('query', searchQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { q, limit = 20 } = c.req.valid('query');

    const orgCheck = await getOrgIdsForAuth(auth);
    if (orgCheck.error) {
      return c.json({ error: orgCheck.error.message }, orgCheck.error.status as 400 | 403 | 404);
    }
    if (orgCheck.orgIds !== null && orgCheck.orgIds.length === 0) {
      return c.json({ results: [] });
    }

    const term = `%${escapeLike(q)}%`;
    const cappedLimit = Math.min(50, Math.max(1, limit));
    // Distribute results so one kind never starves others. Each kind gets
    // up to ~ceil(limit/3) candidates; we then trim to cappedLimit total.
    const perKind = Math.max(2, Math.ceil(cappedLimit / 3));
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const orgFilter = orgCheck.orgIds === null ? undefined : inArray;
    const perms = c.get('permissions') as UserPermissions | undefined;
    const allowedDeviceIds = perms?.allowedSiteIds && auth.orgId
      ? await resolveSiteAllowedDeviceIds(auth.orgId, perms)
      : null;

    const deviceWhere = and(
      orgCheck.orgIds === null ? sql`true` : inArray(devices.orgId, orgCheck.orgIds),
      eq(devices.isEphemeral, false),
      perms?.allowedSiteIds ? inArray(devices.siteId, perms.allowedSiteIds) : sql`true`,
      or(
        ilike(devices.hostname, term),
        ilike(devices.displayName, term),
        ilike(sql`${devices.osType}::text`, term),
        ilike(sites.name, term)
      )
    );

    const alertWhere = and(
      orgCheck.orgIds === null ? sql`true` : inArray(alerts.orgId, orgCheck.orgIds),
      allowedDeviceIds === null ? sql`true` : inArray(alerts.deviceId, allowedDeviceIds),
      gte(alerts.triggeredAt, thirtyDaysAgo),
      or(ilike(alerts.title, term), ilike(alerts.message, term))
    );

    const sessionWhere = and(
      orgCheck.orgIds === null ? sql`true` : inArray(aiSessions.orgId, orgCheck.orgIds),
      gte(aiSessions.lastActivityAt, thirtyDaysAgo),
      ilike(aiSessions.title, term)
    );

    // Suppress the unused-import lint when orgCheck.orgIds is null.
    void orgFilter;

    const [deviceRows, alertRows, sessionRows] = await Promise.all([
      db
        .select({
          id: devices.id,
          orgId: devices.orgId,
          siteId: devices.siteId,
          hostname: devices.hostname,
          displayName: devices.displayName,
          osType: devices.osType,
          status: devices.status,
          lastSeenAt: devices.lastSeenAt,
          siteName: sites.name
        })
        .from(devices)
        .leftJoin(sites, eq(devices.siteId, sites.id))
        .where(deviceWhere)
        .orderBy(desc(devices.lastSeenAt))
        .limit(perKind),
      db
        .select({
          id: alerts.id,
          orgId: alerts.orgId,
          severity: alerts.severity,
          status: alerts.status,
          title: alerts.title,
          message: alerts.message,
          triggeredAt: alerts.triggeredAt,
          deviceId: alerts.deviceId,
          deviceHostname: devices.hostname,
          deviceDisplayName: devices.displayName
        })
        .from(alerts)
        .leftJoin(devices, eq(alerts.deviceId, devices.id))
        .where(alertWhere)
        .orderBy(desc(alerts.triggeredAt))
        .limit(perKind),
      db
        .select({
          id: aiSessions.id,
          orgId: aiSessions.orgId,
          title: aiSessions.title,
          status: aiSessions.status,
          turnCount: aiSessions.turnCount,
          lastActivityAt: aiSessions.lastActivityAt,
          createdAt: aiSessions.createdAt
        })
        .from(aiSessions)
        .where(sessionWhere)
        .orderBy(desc(aiSessions.lastActivityAt))
        .limit(perKind)
    ]);

    const severityRank: Record<string, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      info: 4
    };

    const deviceResults: SearchResult[] = deviceRows.map((row) => {
      const title = row.displayName?.trim() || row.hostname || 'Untitled device';
      const subtitleParts = [
        row.osType ?? null,
        row.siteName ?? null,
        row.status ?? null
      ].filter((v): v is string => Boolean(v));
      return {
        kind: 'device' as const,
        id: row.id,
        title,
        subtitle: subtitleParts.join(' · '),
        meta: {
          orgId: row.orgId,
          siteId: row.siteId ?? null,
          hostname: row.hostname ?? null,
          displayName: row.displayName ?? null,
          osType: row.osType ?? null,
          status: row.status ?? null,
          lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
          siteName: row.siteName ?? null
        }
      };
    });

    const alertResults: SearchResult[] = alertRows.map((row) => {
      const deviceName = row.deviceHostname || row.deviceDisplayName || null;
      const subtitleParts = [row.severity, deviceName].filter((v): v is string => Boolean(v));
      return {
        kind: 'alert' as const,
        id: row.id,
        title: row.title,
        subtitle: subtitleParts.join(' · '),
        meta: {
          orgId: row.orgId,
          severity: row.severity,
          status: row.status,
          deviceId: row.deviceId ?? null,
          deviceName,
          message: row.message ?? null,
          triggeredAt: row.triggeredAt ? new Date(row.triggeredAt).toISOString() : null
        }
      };
    });

    const sessionResults: SearchResult[] = sessionRows.map((row) => ({
      kind: 'session' as const,
      id: row.id,
      title: row.title?.trim() || 'Untitled conversation',
      subtitle: `${row.turnCount} turn${row.turnCount === 1 ? '' : 's'}`,
      meta: {
        orgId: row.orgId,
        status: row.status,
        turnCount: row.turnCount,
        lastActivityAt: row.lastActivityAt ? new Date(row.lastActivityAt).toISOString() : null,
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null
      }
    }));

    // Severity-then-kind ordering: alerts sort by severity, devices and
    // sessions interleave by kind below. We round-robin to avoid one kind
    // monopolising the cap.
    alertResults.sort((a, b) => {
      const aRank = severityRank[(a.meta as { severity: string }).severity] ?? 99;
      const bRank = severityRank[(b.meta as { severity: string }).severity] ?? 99;
      return aRank - bRank;
    });

    const merged: SearchResult[] = [];
    const queues: SearchResult[][] = [alertResults, deviceResults, sessionResults];
    while (merged.length < cappedLimit) {
      let pulled = false;
      for (const queue of queues) {
        if (merged.length >= cappedLimit) break;
        const next = queue.shift();
        if (next) {
          merged.push(next);
          pulled = true;
        }
      }
      if (!pulled) break;
    }

    return c.json({ results: merged });
  }
);
