import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import { CATALOG_BY_ID, CATALOG_TAB_KEYS } from '@breeze/shared';
import { requirePartner, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { zValidator } from '../lib/validation';
import { PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_READ_DENIED_MESSAGE } from '../services/partnerWideAccess';
import {
  aggregateTab,
  InheritanceBadRequest,
  InheritanceNotFound,
  type InheritanceContext,
} from '../services/partnerSettingsInheritance/aggregate';
import { DRILLDOWN_MAX_LIMIT, listFieldOrgs } from '../services/partnerSettingsInheritance/drilldown';
import { BUCKETS } from '../services/partnerSettingsInheritance/bindings';

/**
 * Partner settings inheritance read model (#9170, spec §5.6): per-field org
 * counts for one partner settings tab, and the org drill-down behind a count.
 *
 * Mounted from routes/orgs.ts at '/' AFTER `orgRoutes.use('*', authMiddleware)`
 * (so authentication is inherited) and before `/partners/:id`. Middleware is
 * attached per endpoint and never with `.use('*')`: at a '/' mount a wildcard
 * would gate every unrelated org route.
 *
 * Chain: partner scope (system scope is deliberately excluded) → a partner
 * context → orgs:read → full partner org access (`canManagePartnerWidePolicies`;
 * selected-access users keep every read they have today, just not this fleet
 * analysis) → query validation. Reads run in the caller's request DB context.
 */
export const partnerSettingsInheritanceRoutes = new Hono();

const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);

async function requirePartnerWideRead(c: Context, next: Next) {
  const auth = c.get('auth') as AuthContext;
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: PARTNER_WIDE_READ_DENIED_MESSAGE, code: 'PARTNER_WIDE_REQUIRED' }, 403);
  }
  await next();
}

const tabQuerySchema = z.object({
  tab: z.enum(CATALOG_TAB_KEYS),
});

const orgsQuerySchema = z.object({
  field: z
    .string()
    .max(128)
    .refine((value) => Object.hasOwn(CATALOG_BY_ID, value), { message: 'Unknown setting' }),
  bucket: z.enum(BUCKETS as unknown as ['ownValue', 'overrides', 'shadowed', 'clamped']).default('ownValue'),
  cursor: z.string().max(2048).regex(/^[A-Za-z0-9_-]+$/, 'Invalid cursor').optional(),
  limit: z.coerce.number().int().min(1).max(DRILLDOWN_MAX_LIMIT).default(DRILLDOWN_MAX_LIMIT),
});

function contextOf(c: Context): InheritanceContext {
  const auth = c.get('auth') as AuthContext;
  return { partnerId: auth.partnerId as string, accessibleOrgIds: auth.accessibleOrgIds };
}

function mapKnownError(c: Context, err: unknown) {
  if (err instanceof InheritanceNotFound) return c.json({ error: err.message }, 404);
  if (err instanceof InheritanceBadRequest) return c.json({ error: err.message }, 400);
  throw err;
}

partnerSettingsInheritanceRoutes.get(
  '/partners/me/settings-inheritance',
  requireScope('partner'),
  requirePartner,
  requireOrgRead,
  requirePartnerWideRead,
  zValidator('query', tabQuerySchema),
  async (c) => {
    const { tab } = c.req.valid('query');
    try {
      return c.json({ data: await aggregateTab(tab, contextOf(c)) });
    } catch (err) {
      return mapKnownError(c, err);
    }
  },
);

partnerSettingsInheritanceRoutes.get(
  '/partners/me/settings-inheritance/orgs',
  requireScope('partner'),
  requirePartner,
  requireOrgRead,
  requirePartnerWideRead,
  zValidator('query', orgsQuerySchema),
  async (c) => {
    const { field, bucket, cursor, limit } = c.req.valid('query');
    try {
      return c.json({ data: await listFieldOrgs(field, contextOf(c), { bucket, cursor: cursor ?? null, limit }) });
    } catch (err) {
      return mapKnownError(c, err);
    }
  },
);
