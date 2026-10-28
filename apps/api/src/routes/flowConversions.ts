/**
 * Tool Catalog W06 (#5221) — legacy Job → flow conversions.
 *
 *   GET  /api/v1/flows/conversions/preview/:automationId   automations.read
 *   POST /api/v1/flows/conversions                         automations.write + MFA + interactive session
 *   POST /api/v1/flows/conversions/bulk                    automations.write + MFA + interactive session
 *   GET  /api/v1/flows/conversions[?state=&automationId=]  automations.read
 *   GET  /api/v1/flows/conversions/:id                     automations.read
 *   POST /api/v1/flows/conversions/:id/switch              automations.write + MFA + interactive session
 *
 * Mounted by routes/flows.ts BEFORE its `/:id` routes, so it inherits that
 * router's auth, scope, FLOWS_ENABLED kill switch (404 when off) and the
 * automations.read floor. A partner-wide owner additionally needs
 * canManagePartnerWidePolicies (enforced in the service, partner_wide_forbidden).
 * The switch also runs everything enableFlow runs. Revert (`/:id/revert`) is B4.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { conversionSwitchRequestSchema, FLOW_CONVERSION_STATES } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import { isInteractiveUserSession, requireMfa, requirePermission } from '../middleware/auth';
import {
  createConversion,
  createConversionsForOwner,
  getConversion,
  listConversions,
  previewConversion,
} from '../services/flows/conversion/service';
import { switchConversion } from '../services/flows/conversion/switch';

export const flowConversionRoutes = new Hono();

type Status = 403 | 404 | 409 | 422;

/**
 * Every write: the permission, then MFA (403 MFA_REQUIRED), then a human at
 * the keyboard — an API key, OAuth grant or agent is refused before any lookup
 * (the same rule enableFlow applies, plan Decision 2).
 */
async function requireInteractive(c: Context, next: () => Promise<void>) {
  if (!isInteractiveUserSession(c.get('auth'))) return c.json({ error: 'interactive_session_required' }, 403);
  await next();
}
const requireConversionWrite = [requirePermission('automations', 'write'), requireMfa(), requireInteractive] as const;

const CREATE_STATUS: Record<string, Status> = {
  automation_not_found: 404,
  conversion_exists: 409,
  source_changed: 409,
  unconvertible: 422,
  draft_rejected: 422,
  partner_wide_forbidden: 403,
  interactive_session_required: 403,
};
const SWITCH_STATUS: Record<string, Status> = {
  conversion_not_found: 404,
  flow_not_found: 404,
  not_shadow: 409,
  source_changed: 409,
  version_conflict: 409,
  already_enabled: 409,
  slug_unavailable: 409,
  shadow_too_new: 409,
  shadow_too_short: 409,
  shadow_divergent: 409,
  partner_wide_forbidden: 403,
  interactive_session_required: 403,
  delegation_scope_restricted: 403,
  // Everything else (scope_widening_not_accepted, unconvertible, draft_rejected,
  // generated_script_rejected and enable's 422s) is 422 via `failure`.
};
const BULK_STATUS: Record<string, Status> = {
  partner_wide_forbidden: 403,
  owner_forbidden: 403,
  interactive_session_required: 403,
};

function failure(c: Context, table: Record<string, Status>, result: { ok: false; error: string }) {
  const { ok: _ok, ...body } = result;
  return c.json(body, table[result.error] ?? 422);
}

const automationParamSchema = z.object({ automationId: z.string().uuid() });
const idParamSchema = z.object({ id: z.string().uuid() });
const createSchema = z.object({
  automationId: z.string().uuid(),
  expectedSourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const bulkSchema = z.object({
  ownerScope: z.enum(['organization', 'partner']),
  orgId: z.string().uuid().optional(),
}).strict();
const listQuerySchema = z.object({
  state: z.enum(FLOW_CONVERSION_STATES).optional(),
  automationId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

flowConversionRoutes.get('/preview/:automationId', zValidator('param', automationParamSchema), async (c) => {
  const { automationId } = c.req.valid('param');
  const preview = await previewConversion(c.get('auth'), automationId);
  if (!preview) return c.json({ error: 'automation_not_found' }, 404);
  return c.json(preview);
});

flowConversionRoutes.post('/', ...requireConversionWrite, zValidator('json', createSchema), async (c) => {
  const { automationId, expectedSourceDigest } = c.req.valid('json');
  const result = await createConversion(c.get('auth'), automationId, { expectedSourceDigest });
  if (!result.ok) return failure(c, CREATE_STATUS, result);
  return c.json(result.conversion, 201);
});

flowConversionRoutes.post('/bulk', ...requireConversionWrite, zValidator('json', bulkSchema), async (c) => {
  const body = c.req.valid('json');
  const result = await createConversionsForOwner(c.get('auth'), {
    ownerScope: body.ownerScope,
    ...(body.orgId ? { orgId: body.orgId } : {}),
  });
  if (!result.ok) return failure(c, BULK_STATUS, result);
  return c.json({ created: result.created, skipped: result.skipped });
});

flowConversionRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const q = c.req.valid('query');
  return c.json(await listConversions(c.get('auth'), {
    state: q.state, automationId: q.automationId, limit: q.limit, offset: q.offset,
  }));
});

flowConversionRoutes.get('/:id', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const conversion = await getConversion(c.get('auth'), id);
  if (!conversion) return c.json({ error: 'conversion_not_found' }, 404);
  return c.json(conversion);
});

flowConversionRoutes.post(
  '/:id/switch',
  ...requireConversionWrite,
  zValidator('param', idParamSchema),
  zValidator('json', conversionSwitchRequestSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const result = await switchConversion(c.get('auth'), id, c.req.valid('json'));
    if (!result.ok) return failure(c, SWITCH_STATUS, result);
    const { ok: _ok, ...body } = result;
    return c.json(body);
  },
);
