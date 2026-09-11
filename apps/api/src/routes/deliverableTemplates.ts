/**
 * Deliverable template routes (#5573 W05), mounted at `/deliverable-templates`:
 *
 *   /deliverable-templates[/:setId[/items[/:itemId]]]
 *
 * Gated on `contracts:read` (GET) / `contracts:write` (mutations), the same
 * permission family as the deliverables themselves (spec §12). A template set
 * is org-owned OR partner-wide; partner-wide WRITES are additionally gated in
 * the service on canManagePartnerWidePolicies, which surfaces here as a 403.
 * A set the caller cannot see is 404 (never 403) so existence never leaks.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireScope, requirePermission, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import {
  createTemplateSetSchema, updateTemplateSetSchema, listTemplateSetsQuerySchema,
  createTemplateItemSchema, updateTemplateItemSchema,
} from '@breeze/shared';
import {
  listTemplateSets, getTemplateSet, createTemplateSet, updateTemplateSet, deleteTemplateSet,
  addTemplateItem, updateTemplateItem, removeTemplateItem,
  type TemplateActor,
} from '../services/deliverableTemplateService';
import { PartnerWideWriteDeniedError, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';

export const deliverableTemplateRoutes = new Hono();
deliverableTemplateRoutes.use('*', authMiddleware);

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);

const setParam = z.object({ setId: z.string().guid() });
const itemParam = setParam.extend({ itemId: z.string().guid() });

export function templateActorFrom(c: { get: (k: string) => unknown }): TemplateActor {
  const auth = c.get('auth') as AuthContext;
  return {
    userId: auth.user?.id ?? null,
    scope: auth.scope,
    partnerId: auth.partnerId ?? null,
    partnerOrgAccess: auth.partnerOrgAccess ?? null,
    accessibleOrgIds: auth.accessibleOrgIds,
  };
}

/**
 * Maps `PartnerWideWriteDeniedError` (403) and `TemplateServiceError`
 * (status + code + optional details) onto the `{ error, code, details? }`
 * envelope. The TemplateServiceError match is structural, like
 * handleDeliverableError, so it survives module mocking. Anything else is
 * rethrown for the global error handler.
 */
export function handleTemplateError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof PartnerWideWriteDeniedError) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'PARTNER_WIDE_WRITE_DENIED' }, 403);
  }
  if (
    err && typeof err === 'object' && 'status' in err && 'code' in err
    && typeof (err as { status: unknown }).status === 'number' && typeof (err as { code: unknown }).code === 'string'
  ) {
    const e = err as { status: number; code: string; message?: string; details?: unknown };
    return c.json(
      { error: e.message ?? e.code, code: e.code, ...(e.details !== undefined ? { details: e.details } : {}) },
      e.status as ContentfulStatusCode,
    );
  }
  throw err;
}

// ── Sets ────────────────────────────────────────────────────────────────────

deliverableTemplateRoutes.get(
  '/',
  scopes, readPerm,
  zValidator('query', listTemplateSetsQuerySchema),
  async (c) => {
    try {
      return c.json({ data: await listTemplateSets(templateActorFrom(c), { orgId: c.req.valid('query').orgId }) });
    } catch (err) { return handleTemplateError(c, err); }
  },
);

deliverableTemplateRoutes.post(
  '/',
  scopes, writePerm,
  zValidator('json', createTemplateSetSchema),
  async (c) => {
    try {
      return c.json({ data: await createTemplateSet(c.req.valid('json'), templateActorFrom(c)) });
    } catch (err) { return handleTemplateError(c, err); }
  },
);

deliverableTemplateRoutes.get(
  '/:setId',
  scopes, readPerm,
  zValidator('param', setParam),
  async (c) => {
    try {
      return c.json({ data: await getTemplateSet(c.req.valid('param').setId, templateActorFrom(c)) });
    } catch (err) { return handleTemplateError(c, err); }
  },
);

deliverableTemplateRoutes.patch(
  '/:setId',
  scopes, writePerm,
  zValidator('param', setParam), zValidator('json', updateTemplateSetSchema),
  async (c) => {
    try {
      return c.json({ data: await updateTemplateSet(c.req.valid('param').setId, c.req.valid('json'), templateActorFrom(c)) });
    } catch (err) { return handleTemplateError(c, err); }
  },
);

deliverableTemplateRoutes.delete(
  '/:setId',
  scopes, writePerm,
  zValidator('param', setParam),
  async (c) => {
    try {
      await deleteTemplateSet(c.req.valid('param').setId, templateActorFrom(c));
      return c.json({ data: { ok: true } });
    } catch (err) { return handleTemplateError(c, err); }
  },
);

// ── Items ───────────────────────────────────────────────────────────────────

deliverableTemplateRoutes.post(
  '/:setId/items',
  scopes, writePerm,
  zValidator('param', setParam), zValidator('json', createTemplateItemSchema),
  async (c) => {
    try {
      return c.json({ data: await addTemplateItem(c.req.valid('param').setId, c.req.valid('json'), templateActorFrom(c)) });
    } catch (err) { return handleTemplateError(c, err); }
  },
);

deliverableTemplateRoutes.patch(
  '/:setId/items/:itemId',
  scopes, writePerm,
  zValidator('param', itemParam), zValidator('json', updateTemplateItemSchema),
  async (c) => {
    const { setId, itemId } = c.req.valid('param');
    try {
      return c.json({ data: await updateTemplateItem(setId, itemId, c.req.valid('json'), templateActorFrom(c)) });
    } catch (err) { return handleTemplateError(c, err); }
  },
);

deliverableTemplateRoutes.delete(
  '/:setId/items/:itemId',
  scopes, writePerm,
  zValidator('param', itemParam),
  async (c) => {
    const { setId, itemId } = c.req.valid('param');
    try {
      await removeTemplateItem(setId, itemId, templateActorFrom(c));
      return c.json({ data: { ok: true } });
    } catch (err) { return handleTemplateError(c, err); }
  },
);
