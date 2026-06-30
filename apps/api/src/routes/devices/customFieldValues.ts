import { Hono, type Context, type Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../../db';
import { devices } from '../../db/schema';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../../middleware/auth';
import { apiKeyAuthMiddleware, requireApiKeyScope } from '../../middleware/apiKeyAuth';
import { getDeviceWithOrgCheck } from './helpers';
import { canAccessSite, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { createAuditLog } from '../../services/auditService';
import { ANONYMOUS_ACTOR_ID } from '../../services/auditEvents';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

/**
 * Device custom-field VALUE read/write API.
 *
 * Device custom-field values live in the `devices.custom_fields` JSONB column.
 * The only built-in way to write them used to be `PATCH /devices/:id`, which is
 * gated on `authMiddleware` (browser session JWT only) + `requireMfa()` — so an
 * automation calling with an `X-API-Key` header was rejected at the very first
 * gate with `401 "Missing or invalid authorization header"` (issue #2066). There
 * was no API-key-authenticated path to stash a value (e.g. a script writing a
 * BitLocker recovery key into a custom field).
 *
 * NOT A SECRETS STORE: `custom_fields` is general automation/inventory data
 * stored in plaintext JSONB with no field-level encryption. It is the right
 * place for asset tags, notes, external IDs, etc. — it is NOT a vault. Real
 * secrets (BitLocker/FileVault recovery keys and similar) belong in the
 * dedicated, encrypted recovery-key feature tracked in #2021; exposing a value
 * write here does not bless `custom_fields` as secret storage. Writes are
 * audited synchronously below so a secret-class value (if a user stashes one
 * anyway) at least leaves a durable trail.
 *
 * This router adds a dedicated value endpoint that accepts EITHER auth flavour,
 * mirroring the dual-auth pattern in `routes/devPush.ts`:
 *   - `X-API-Key` → `apiKeyAuthMiddleware` + `requireApiKeyScope('devices:write'|'devices:read')`
 *   - `Authorization: Bearer` → `authMiddleware` + scope + `devices:write|read` permission
 *     (+ `requireMfa()` on writes, matching the existing device PATCH posture)
 *
 * Tenant isolation: API-key auth runs every downstream query under a
 * `withDbAccessContext` scoped to the key's single org, so `devices` RLS
 * (direct `org_id`, shape 1) already denies cross-tenant rows. `getDeviceWithOrgCheck`
 * + the explicit `org_id` predicate on the UPDATE are belt-and-suspenders on top
 * of that — a key (or session) can only read/write values for devices in an org
 * it can access.
 *
 * IMPORTANT — auth wiring: these routes use PER-ROUTE auth middleware (never
 * `router.use('*', ...)`) and the router is mounted FIRST in `devices/index.ts`,
 * BEFORE `coreRoutes` and the other `.use('*', authMiddleware)` sub-routers. A
 * wildcard `.use('*')` in a sibling sub-router attaches to every route mounted
 * AFTER it, so mounting after `coreRoutes` would re-introduce the session-only
 * `authMiddleware` ahead of our API-key branch and resurrect the 401. See the
 * `hono_router_use_wildcard_root_mount_auth_leak` lesson.
 */
export const customFieldValuesRoutes = new Hono();

// Field map shared by read/write. Mirrors `updateDeviceSchema.customFields` in
// devices/schemas.ts so the value constraints stay identical to the existing
// PATCH /devices/:id write path.
const customFieldValueSchema = z
  .record(
    z.string().min(1).max(100),
    z.union([z.string().max(10000), z.number(), z.boolean(), z.null()]),
  )
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one custom field must be provided',
  });

// Accept JWT (Authorization: Bearer) or API key (X-API-Key). The write variant
// additionally requires MFA on the JWT path to match PATCH /devices/:id.
function dualAuth(
  apiKeyScope: 'devices:read' | 'devices:write',
  permission: { resource: string; action: string },
  options: { mfa?: boolean } = {},
) {
  return async (c: Context, next: Next) => {
    const apiKeyHeader = c.req.header('X-API-Key');
    if (apiKeyHeader) {
      return apiKeyAuthMiddleware(c, async () => {
        await requireApiKeyScope(apiKeyScope)(c, next);
      });
    }
    return authMiddleware(c, async () => {
      await requireScope('organization', 'partner', 'system')(c, async () => {
        await requirePermission(permission.resource, permission.action)(c, async () => {
          if (options.mfa) {
            await requireMfa()(c, next);
          } else {
            await next();
          }
        });
      });
    });
  };
}

interface ResolvedAccess {
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>;
  permissions: UserPermissions | undefined;
  audit: { actorType: 'user' | 'api_key'; actorId: string | null; actorEmail: string | null };
}

// Build a uniform org-scope + audit-actor view from whichever auth flavour ran.
function resolveAccess(c: Context): ResolvedAccess {
  const jwtAuth = c.get('auth') as AuthContext | undefined;
  if (jwtAuth) {
    return {
      auth: jwtAuth,
      permissions: c.get('permissions') as UserPermissions | undefined,
      audit: {
        actorType: 'user',
        actorId: jwtAuth.user?.id ?? null,
        actorEmail: jwtAuth.user?.email ?? null,
      },
    };
  }

  const apiKey = c.get('apiKey');
  // Fail closed: reaching here without an apiKey context means neither auth
  // branch populated a principal (dualAuth always sets one or throws), so never
  // synthesize an authorized scope from a missing key.
  if (!apiKey) {
    throw new HTTPException(401, { message: 'Authentication required' });
  }
  // apiKeyAuthMiddleware only admits keys whose owning org is active (it 401s
  // otherwise), so a null org here means the auth context is malformed. Fail
  // closed rather than synthesizing an org-less scope.
  const orgId = apiKey.orgId;
  if (!orgId) {
    throw new HTTPException(401, { message: 'API key is not scoped to an organization' });
  }
  return {
    auth: {
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId],
      canAccessOrg: (candidate: string) => candidate === orgId,
    },
    permissions: undefined,
    audit: { actorType: 'api_key', actorId: apiKey.id, actorEmail: null },
  };
}

const SITE_DENIED = Symbol('SITE_DENIED');

// Org-scoped device lookup that also honours a session's site allowlist. API
// keys carry no `permissions` context (they're org-scoped, not site-scoped), so
// the site check is skipped for them — same as devPush's API-key branch.
async function loadAccessibleDevice(
  deviceId: string,
  access: ResolvedAccess,
): Promise<typeof devices.$inferSelect | null | typeof SITE_DENIED> {
  const device = await getDeviceWithOrgCheck(deviceId, access.auth);
  if (!device) return null;

  const perms = access.permissions;
  if (perms?.allowedSiteIds && (typeof device.siteId !== 'string' || !canAccessSite(perms, device.siteId))) {
    return SITE_DENIED;
  }
  return device;
}

function readExistingCustomFields(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

// GET /devices/:id/custom-fields — read the device's custom-field values.
customFieldValuesRoutes.get(
  '/:id/custom-fields',
  dualAuth('devices:read', { resource: PERMISSIONS.DEVICES_READ.resource, action: PERMISSIONS.DEVICES_READ.action }),
  async (c) => {
    const deviceId = c.req.param('id')!;
    const access = resolveAccess(c);

    const device = await loadAccessibleDevice(deviceId, access);
    if (device === SITE_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    return c.json({ customFields: readExistingCustomFields(device.customFields) });
  },
);

// PATCH /devices/:id/custom-fields — merge custom-field values into the device.
// Body is the field map directly, e.g. `{ "bitlocker_recovery_key": "..." }`.
customFieldValuesRoutes.patch(
  '/:id/custom-fields',
  dualAuth(
    'devices:write',
    { resource: PERMISSIONS.DEVICES_WRITE.resource, action: PERMISSIONS.DEVICES_WRITE.action },
    { mfa: true },
  ),
  zValidator('json', customFieldValueSchema),
  async (c) => {
    const deviceId = c.req.param('id')!;
    const access = resolveAccess(c);
    const updates = c.req.valid('json');

    const device = await loadAccessibleDevice(deviceId, access);
    if (device === SITE_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Merge with existing values rather than replacing the whole object, matching
    // the PATCH /devices/:id semantics.
    const merged = { ...readExistingCustomFields(device.customFields), ...updates };

    const [updated] = await db
      .update(devices)
      .set({ customFields: merged, updatedAt: new Date() })
      // The org predicate is redundant under RLS + the org-checked lookup above,
      // but pins the write to the exact verified device as defense-in-depth.
      .where(and(eq(devices.id, deviceId), eq(devices.orgId, device.orgId)))
      .returning({ customFields: devices.customFields });

    if (!updated) {
      return c.json({ error: 'Device not found' }, 404);
    }

    // Audit SYNCHRONOUSLY (await, not fire-and-forget): a custom-field write can
    // carry a secret-class value, so we want the trail to be durable before we
    // report success. `createAuditLog` rejects on DB failure — we let that
    // propagate to a 500 so the caller knows the audit did not land (the merge
    // is idempotent, so a retry is safe). Only field KEYS are recorded, never
    // values, so no secret enters the audit payload.
    await createAuditLog({
      orgId: device.orgId,
      actorType: access.audit.actorType,
      actorId: access.audit.actorId ?? ANONYMOUS_ACTOR_ID,
      actorEmail: access.audit.actorEmail ?? undefined,
      action: 'device.custom_field.update',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname ?? device.displayName ?? undefined,
      details: { changedFields: Object.keys(updates) },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: 'success',
      initiatedBy: access.audit.actorType === 'api_key' ? 'integration' : 'manual',
    });

    return c.json({ customFields: readExistingCustomFields(updated.customFields) });
  },
);
