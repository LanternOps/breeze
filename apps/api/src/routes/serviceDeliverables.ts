/**
 * Service deliverable routes (#5573 W01), mounted at `/orgs`:
 *
 *   /orgs/:orgId/deliverables[/:id[/occurrences]]
 *   /orgs/:orgId/deliverables/occurrences/:oId/{deliver,waive,reopen,reschedule,evidence[/:eId]}
 *
 * A sibling `/orgs` router in the orgSummary / orgArchive style: it owns its
 * own authMiddleware. Gated on `contracts:read` (GET) / `contracts:write`
 * (mutations) — deliverables are a contract-adjacent concept and share the
 * contracts permission family (spec §12). Org access itself is enforced in
 * the service (404 `NOT_FOUND`, never 403, so existence never leaks).
 *
 * Route order matters: the literal `/:orgId/deliverables/occurrences/...`
 * paths are registered BEFORE `/:orgId/deliverables/:id` so "occurrences" is
 * never captured as a deliverable id.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireScope, requirePermission, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import {
  applyTemplateSetSchema,
  createDeliverableSchema, updateDeliverableSchema, listDeliverablesQuerySchema,
  deliverOccurrenceSchema, waiveOccurrenceSchema, rescheduleOccurrenceSchema,
  addEvidenceSchema, listOccurrencesQuerySchema,
} from '@breeze/shared';
import {
  listDeliverables, getDeliverable, createDeliverable, updateDeliverable, deactivateDeliverable,
  listOccurrences, deliverOccurrence, waiveOccurrence, reopenOccurrence, rescheduleOccurrence,
  addEvidence, removeEvidence,
  type DeliverableActor,
} from '../services/serviceDeliverableService';
import { applyTemplateSet } from '../services/deliverableTemplateService';
import { templateActorFrom, handleTemplateError } from './deliverableTemplates';

export const serviceDeliverableRoutes = new Hono();
serviceDeliverableRoutes.use('*', authMiddleware);

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.CONTRACTS_WRITE.resource, PERMISSIONS.CONTRACTS_WRITE.action);

const orgParam = z.object({ orgId: z.string().guid() });
const deliverableParam = orgParam.extend({ id: z.string().guid() });
const occurrenceParam = orgParam.extend({ oId: z.string().guid() });
const evidenceParam = occurrenceParam.extend({ eId: z.string().guid() });

export function deliverableActorFrom(c: { get: (k: string) => unknown }): DeliverableActor {
  const auth = c.get('auth') as AuthContext;
  return {
    userId: auth.user?.id ?? null,
    partnerId: auth.partnerId ?? null,
    accessibleOrgIds: auth.accessibleOrgIds,
  };
}

/**
 * Maps `DeliverableServiceError` and `InvalidTransitionError`
 * (services/serviceDeliverableState.ts, status 409) onto the
 * `{ error, code, details? }` envelope. Both carry `status` + `code`, so the
 * match is structural rather than `instanceof` — the class identity is not
 * load-bearing, and a structural match also survives module mocking. Anything
 * else is rethrown for the global error handler.
 */
export function handleDeliverableError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (
    err && typeof err === 'object' && 'status' in err && 'code' in err
    && typeof (err as { status: unknown }).status === 'number' && typeof (err as { code: unknown }).code === 'string'
  ) {
    const e = err as { status: number; code: string; message?: string; details?: unknown };
    return c.json(
      { error: e.message ?? e.code, code: e.code, ...(e.details !== undefined ? { details: e.details } : {}) },
      e.status,
    );
  }
  throw err;
}

// ── Deliverables ────────────────────────────────────────────────────────────

serviceDeliverableRoutes.get(
  '/:orgId/deliverables',
  scopes, readPerm,
  zValidator('param', orgParam), zValidator('query', listDeliverablesQuerySchema),
  async (c) => {
    try {
      return c.json({ data: await listDeliverables(c.req.valid('param').orgId, c.req.valid('query'), deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

serviceDeliverableRoutes.post(
  '/:orgId/deliverables',
  scopes, writePerm,
  zValidator('param', orgParam), zValidator('json', createDeliverableSchema),
  async (c) => {
    try {
      return c.json({ data: await createDeliverable(c.req.valid('param').orgId, c.req.valid('json'), deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

// ── Occurrences (literal `occurrences` segment — MUST precede `/:id`) ──────

serviceDeliverableRoutes.post(
  '/:orgId/deliverables/occurrences/:oId/deliver',
  scopes, writePerm,
  zValidator('param', occurrenceParam), zValidator('json', deliverOccurrenceSchema),
  async (c) => {
    const { orgId, oId } = c.req.valid('param');
    try {
      return c.json({ data: await deliverOccurrence(orgId, oId, c.req.valid('json'), deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

serviceDeliverableRoutes.post(
  '/:orgId/deliverables/occurrences/:oId/waive',
  scopes, writePerm,
  zValidator('param', occurrenceParam), zValidator('json', waiveOccurrenceSchema),
  async (c) => {
    const { orgId, oId } = c.req.valid('param');
    try {
      return c.json({ data: await waiveOccurrence(orgId, oId, c.req.valid('json'), deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

serviceDeliverableRoutes.post(
  '/:orgId/deliverables/occurrences/:oId/reopen',
  scopes, writePerm,
  zValidator('param', occurrenceParam),
  async (c) => {
    const { orgId, oId } = c.req.valid('param');
    try {
      return c.json({ data: await reopenOccurrence(orgId, oId, deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

serviceDeliverableRoutes.post(
  '/:orgId/deliverables/occurrences/:oId/reschedule',
  scopes, writePerm,
  zValidator('param', occurrenceParam), zValidator('json', rescheduleOccurrenceSchema),
  async (c) => {
    const { orgId, oId } = c.req.valid('param');
    try {
      return c.json({ data: await rescheduleOccurrence(orgId, oId, c.req.valid('json'), deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

serviceDeliverableRoutes.post(
  '/:orgId/deliverables/occurrences/:oId/evidence',
  scopes, writePerm,
  zValidator('param', occurrenceParam), zValidator('json', addEvidenceSchema),
  async (c) => {
    const { orgId, oId } = c.req.valid('param');
    try {
      return c.json({ data: await addEvidence(orgId, oId, c.req.valid('json'), deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

serviceDeliverableRoutes.delete(
  '/:orgId/deliverables/occurrences/:oId/evidence/:eId',
  scopes, writePerm,
  zValidator('param', evidenceParam),
  async (c) => {
    const { orgId, oId, eId } = c.req.valid('param');
    try {
      return c.json({ data: await removeEvidence(orgId, oId, eId, deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

// ── Apply a template set (literal segment — MUST precede `/:id`) ───────────

serviceDeliverableRoutes.post(
  '/:orgId/deliverables/apply-template',
  scopes, writePerm,
  zValidator('param', orgParam), zValidator('json', applyTemplateSetSchema),
  async (c) => {
    const { setId, contractId, effectiveFrom, ownerUserId } = c.req.valid('json');
    try {
      return c.json({
        data: await applyTemplateSet(
          c.req.valid('param').orgId, setId,
          { contractId, effectiveFrom, ownerUserId },
          templateActorFrom(c),
        ),
      });
    } catch (err) { return handleTemplateError(c, err); }
  },
);

// ── Single deliverable (param matchers last) ───────────────────────────────

serviceDeliverableRoutes.get(
  '/:orgId/deliverables/:id',
  scopes, readPerm,
  zValidator('param', deliverableParam),
  async (c) => {
    const { orgId, id } = c.req.valid('param');
    try {
      return c.json({ data: await getDeliverable(orgId, id, deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

serviceDeliverableRoutes.patch(
  '/:orgId/deliverables/:id',
  scopes, writePerm,
  zValidator('param', deliverableParam), zValidator('json', updateDeliverableSchema),
  async (c) => {
    const { orgId, id } = c.req.valid('param');
    try {
      return c.json({ data: await updateDeliverable(orgId, id, c.req.valid('json'), deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

serviceDeliverableRoutes.delete(
  '/:orgId/deliverables/:id',
  scopes, writePerm,
  zValidator('param', deliverableParam),
  async (c) => {
    const { orgId, id } = c.req.valid('param');
    try {
      await deactivateDeliverable(orgId, id, deliverableActorFrom(c));
      return c.json({ data: { ok: true } });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);

serviceDeliverableRoutes.get(
  '/:orgId/deliverables/:id/occurrences',
  scopes, readPerm,
  zValidator('param', deliverableParam), zValidator('query', listOccurrencesQuerySchema),
  async (c) => {
    const { orgId, id } = c.req.valid('param');
    try {
      return c.json({ data: await listOccurrences(orgId, id, c.req.valid('query'), deliverableActorFrom(c)) });
    } catch (err) { return handleDeliverableError(c, err); }
  },
);
