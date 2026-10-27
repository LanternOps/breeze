import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requireScope, requirePermission, requireMfa } from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  listManualAssets,
  createManualAsset,
  updateManualAsset,
  deleteManualAsset,
  linkManualAsset,
  unlinkManualAsset,
  type SiteAllowed,
} from '../../services/manualAssetOps';
import {
  listManualAssetsSchema,
  createManualAssetSchema,
  updateManualAssetSchema,
  linkManualAssetSchema,
} from './schemas';

export const manualRoutes = new Hono();

manualRoutes.use('*', authMiddleware);

/**
 * The manual arm of the unified Devices list (#4622 W02).
 *
 * Surfaces hand-entered, non-networked inventory rows (`manual_assets`) —
 * a spare laptop, a desk phone, a non-networked printer — normalized into
 * the same presentation shape the agent-device and network arms use,
 * tagged `deviceClass: 'manual'`.
 *
 * The logic lives in services/manualAssetOps.ts (shared with the AI tools);
 * these handlers are thin adapters: middleware + validation, then the service.
 *
 * Deliberate omissions, matching the design spec:
 *   - Every mutator carries `requireMfa()` (session completed MFA), matching
 *     both sibling classes: device edit (`core.ts` PATCH /:id) and the
 *     discovery mutators (`discovery.ts`). The read does not. The spec's
 *     original "no step-up" line rested on the false claim that device edit
 *     is ungated; corrected on merge of W02 (#5255).
 *   - `GET` excludes retired rows and rows already linked to a device or a
 *     discovered asset — a linked row already surfaces through the arm it
 *     was linked to, so including it here would double-count one physical
 *     asset.
 *   - Serial number is never uniquely constrained (spec: serials are not
 *     globally unique across manufacturers). `POST` runs a soft
 *     `org_id + upper(serial_number)` duplicate check and returns a
 *     non-blocking warning; it never blocks the create.
 */

// App-layer site-scope gate: a caller with no `allowedSiteIds` restriction may
// touch any site; a restricted caller only the sites on the allowlist.
function siteAllowedFor(perms: UserPermissions | undefined): SiteAllowed {
  return (siteId) => !perms?.allowedSiteIds || canAccessSite(perms, siteId);
}

function getPerms(c: Context): UserPermissions | undefined {
  return c.get('permissions') as UserPermissions | undefined;
}

// GET /devices/manual — mirrors network.ts's org/site scoping exactly so the
// three arms of the unified list filter consistently.
manualRoutes.get(
  '/manual',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', listManualAssetsSchema),
  async (c) => {
    const perms = getPerms(c);
    const result = await listManualAssets({
      auth: c.get('auth'),
      query: c.req.valid('query'),
      allowedSiteIds: perms?.allowedSiteIds ?? null,
      siteAllowed: siteAllowedFor(perms),
    });
    return c.json(result.body, result.status);
  },
);

// POST /devices/manual — create a manual (non-networked) inventory asset.
manualRoutes.post(
  '/manual',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', createManualAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const result = await createManualAsset({
      auth,
      actorUserId: auth.user.id,
      data: c.req.valid('json'),
      siteAllowed: siteAllowedFor(getPerms(c)),
      audit: (e) => writeRouteAudit(c, e),
    });
    return c.json(result.body, result.status);
  },
);

// PATCH /devices/manual/:id
manualRoutes.patch(
  '/manual/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', updateManualAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const result = await updateManualAsset({
      auth,
      actorUserId: auth.user.id,
      id: c.req.param('id')!,
      data: c.req.valid('json'),
      siteAllowed: siteAllowedFor(getPerms(c)),
      audit: (e) => writeRouteAudit(c, e),
    });
    return c.json(result.body, result.status);
  },
);

// DELETE /devices/manual/:id — hard delete.
manualRoutes.delete(
  '/manual/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_DELETE.resource, PERMISSIONS.DEVICES_DELETE.action),
  requireMfa(),
  async (c) => {
    const result = await deleteManualAsset({
      auth: c.get('auth'),
      id: c.req.param('id')!,
      siteAllowed: siteAllowedFor(getPerms(c)),
      audit: (e) => writeRouteAudit(c, e),
    });
    return c.json(result.body, result.status);
  },
);

// POST /devices/manual/:id/link — deviceId XOR discoveredAssetId (enforced by
// the Zod schema). Same-org AND same-site required, mirroring
// discovery.ts's POST /assets/:id/link. A cross-org target resolves to the
// SAME 404 as a missing target — never leak existence of a record in another
// tenant.
manualRoutes.post(
  '/manual/:id/link',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', linkManualAssetSchema),
  async (c) => {
    const auth = c.get('auth');
    const result = await linkManualAsset({
      auth,
      actorUserId: auth.user.id,
      id: c.req.param('id')!,
      body: c.req.valid('json'),
      siteAllowed: siteAllowedFor(getPerms(c)),
      audit: (e) => writeRouteAudit(c, e),
    });
    return c.json(result.body, result.status);
  },
);

// DELETE /devices/manual/:id/link — clears both link columns unconditionally.
manualRoutes.delete(
  '/manual/:id/link',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const result = await unlinkManualAsset({
      auth,
      actorUserId: auth.user.id,
      id: c.req.param('id')!,
      siteAllowed: siteAllowedFor(getPerms(c)),
      audit: (e) => writeRouteAudit(c, e),
    });
    return c.json(result.body, result.status);
  },
);
